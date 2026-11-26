package com.mypal.app;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;

/** Версия установленного APK: при обновлении приложение заново распаковывается. */
final class BuildConfigCompat {
    private BuildConfigCompat() { }

    static String versionCode(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            return code + "-" + pi.lastUpdateTime;
        } catch (Exception e) {
            return "0";
        }
    }
}
