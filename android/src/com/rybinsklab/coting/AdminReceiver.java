package com.rybinsklab.coting;

import android.app.admin.DeviceAdminReceiver;

/**
 * Права администратора Coting (активируются владельцем вручную).
 * Политика только force-lock: агент может заблокировать экран (/action lock).
 * Больше ничего — ни wipe, ни паролей: минимум привилегий.
 */
public class AdminReceiver extends DeviceAdminReceiver {
}
