#pragma once

/*
 * Process-wide structured logging to stderr:
 *   2026-01-02T03:04:05.123Z [pay-orders] message text
 *
 * The process name is set once via log_init() before any log_msg() call.
 */

void log_init(const char *proc_name);

void log_msg(const char *fmt, ...)
#if defined(__GNUC__) || defined(__clang__)
    __attribute__((format(printf, 1, 2)))
#endif
    ;
