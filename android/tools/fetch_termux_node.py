#!/usr/bin/env python3
"""
Готовит Node.js для APK из пакетов Termux (они собраны под Android/bionic).

  python3 fetch_termux_node.py --arch aarch64 --abi arm64-v8a --jni app/src/main/jniLibs --assets app/src/main/assets

Что делает:
 1. Качает индекс пакетов Termux, находит nodejs-lts (или nodejs) и все зависимости, распаковывает .deb.
 2. Собирает node и только те .so, которые ему реально нужны (по DT_NEEDED, рекурсивно).
 3. Android распаковывает из APK только файлы вида lib*.so, поэтому:
      node              → libnode.so
      libicuuc.so.78    → libicuuc78.so  (+ patchelf --replace-needed во всех файлах, --set-soname)
 4. Убирает RUNPATH Termux (/data/data/com.termux/...) — библиотеки ищутся через LD_LIBRARY_PATH.
 5. Кладёт сертификаты (cacert.pem) в assets — для HTTPS к API нейросетей.
Нужны: python3, dpkg-deb, readelf, patchelf.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

MIRRORS = [
    'https://packages-cf.termux.dev/apt/termux-main',
    'https://packages.termux.dev/apt/termux-main',
    'https://grimler.se/termux/termux-main',
]
# системные библиотеки Android — их не кладём
SYSTEM_LIBS = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so', 'ld-android.so', 'libz.so'}
PREFIX = 'data/data/com.termux/files/usr'


def fetch(url, dest=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'mypal-apk-build'})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    if dest:
        with open(dest, 'wb') as f:
            f.write(data)
    return data


def load_index(arch):
    last = None
    for m in MIRRORS:
        try:
            text = fetch(f'{m}/dists/stable/main/binary-{arch}/Packages').decode('utf-8')
            pkgs = {}
            for stanza in text.split('\n\n'):
                fields = {}
                for line in stanza.splitlines():
                    if ':' in line and not line.startswith(' '):
                        k, v = line.split(':', 1)
                        fields[k.strip()] = v.strip()
                if 'Package' in fields:
                    pkgs[fields['Package']] = fields
            print(f'index: {m} ({len(pkgs)} пакетов)')
            return m, pkgs
        except Exception as e:  # пробуем следующее зеркало
            last = e
            print(f'зеркало {m} недоступно: {e}', file=sys.stderr)
    raise SystemExit(f'Не удалось скачать индекс Termux: {last}')


def parse_deps(s):
    out = []
    for part in (s or '').split(','):
        part = part.strip()
        if not part:
            continue
        name = part.split('|')[0].strip()           # альтернативы: берём первую
        name = re.sub(r'\s*\(.*\)', '', name).strip()  # убираем ограничения версий
        out.append(name)
    return out


def version_tuple(v):
    v = v.split(':')[-1].split('-')[0]
    return tuple(int(x) for x in re.findall(r'\d+', v)[:3])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arch', required=True, help='aarch64 | arm | x86_64 | i686')
    ap.add_argument('--abi', required=True, help='arm64-v8a | armeabi-v7a | x86_64 | x86')
    ap.add_argument('--jni', required=True)
    ap.add_argument('--assets', required=True)
    a = ap.parse_args()

    mirror, pkgs = load_index(a.arch)
    node_pkg = None
    for cand in ('nodejs-lts', 'nodejs'):
        p = pkgs.get(cand)
        if p and version_tuple(p['Version']) >= (22, 13, 0):
            node_pkg = cand
            break
    if not node_pkg:
        raise SystemExit('В Termux нет Node.js >= 22.13')
    print(f'node: {node_pkg} {pkgs[node_pkg]["Version"]}')

    # зависимости рекурсивно
    todo, seen = [node_pkg, 'ca-certificates'], set()
    while todo:
        n = todo.pop()
        if n in seen or n not in pkgs:
            continue
        seen.add(n)
        todo.extend(parse_deps(pkgs[n].get('Depends')) + parse_deps(pkgs[n].get('Pre-Depends')))
    print('пакеты:', ', '.join(sorted(seen)))

    work = tempfile.mkdtemp(prefix=f'termux-{a.arch}-')
    root = os.path.join(work, 'root')
    os.makedirs(root)
    for n in sorted(seen):
        deb = os.path.join(work, f'{n}.deb')
        fetch(f'{mirror}/{pkgs[n]["Filename"]}', deb)
        subprocess.run(['dpkg-deb', '-x', deb, root], check=True)

    usr = os.path.join(root, PREFIX)
    libdir = os.path.join(usr, 'lib')
    node_bin = os.path.join(usr, 'bin', 'node')
    if not os.path.isfile(node_bin):
        raise SystemExit('node не найден в пакете')

    def needed(path):
        out = subprocess.run(['readelf', '-d', path], capture_output=True, text=True, check=True).stdout
        return re.findall(r'\(NEEDED\)\s+Shared library: \[(.+?)\]', out)

    # обход зависимостей .so
    libs, queue = {}, needed(node_bin)
    while queue:
        name = queue.pop()
        if name in libs or name in SYSTEM_LIBS:
            continue
        path = os.path.join(libdir, name)
        if not os.path.exists(path):
            raise SystemExit(f'Нет библиотеки {name} (нужна для node)')
        libs[name] = os.path.realpath(path)
        queue.extend(needed(libs[name]))

    def apk_name(name):
        if re.fullmatch(r'lib.+\.so', name):
            return name
        m = re.fullmatch(r'(lib.+?)\.so\.([\d.]+)', name)
        if not m:
            raise SystemExit(f'Неожиданное имя библиотеки: {name}')
        return f'{m.group(1)}{m.group(2).replace(".", "_")}.so'

    rename = {n: apk_name(n) for n in libs}
    out_dir = os.path.join(a.jni, a.abi)
    os.makedirs(out_dir, exist_ok=True)
    outputs = []
    shutil.copyfile(node_bin, os.path.join(out_dir, 'libnode.so'))
    outputs.append(os.path.join(out_dir, 'libnode.so'))
    for n, real in libs.items():
        dst = os.path.join(out_dir, rename[n])
        shutil.copyfile(real, dst)
        outputs.append(dst)

    for f in outputs:
        os.chmod(f, 0o755)
        args = ['patchelf']
        for old, new in rename.items():
            if old != new:
                args += ['--replace-needed', old, new]
        base = os.path.basename(f)
        if base != 'libnode.so':
            args += ['--set-soname', base]
        args += ['--remove-rpath', f]
        subprocess.run(args, check=True)

    # сертификаты для HTTPS
    os.makedirs(a.assets, exist_ok=True)
    cert = os.path.join(usr, 'etc', 'tls', 'cert.pem')
    if os.path.exists(cert):
        shutil.copyfile(os.path.realpath(cert), os.path.join(a.assets, 'cacert.pem'))
    else:
        raise SystemExit('Нет cert.pem в ca-certificates')

    total = sum(os.path.getsize(f) for f in outputs)
    print(f'{a.abi}: {len(outputs)} файлов, {total / 1e6:.1f} МБ')
    for f in sorted(outputs):
        print('  ', os.path.basename(f), ' <- NEEDED:', ', '.join(needed(f)))
    shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
