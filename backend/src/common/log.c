#define _POSIX_C_SOURCE 200809L

#include <stdarg.h>
#include <stdio.h>
#include <time.h>

static const char *proc_name = "backend";

void log_init(const char *name)
{
    proc_name = name;
}

void log_msg(const char *fmt, ...)
{
    time_t now = time(NULL);
    struct tm tm_utc;
    char ts[24];

    gmtime_r(&now, &tm_utc);
    strftime(ts, sizeof ts, "%Y-%m-%dT%H:%M:%S", &tm_utc);

    struct timespec now_precise;
    clock_gettime(CLOCK_REALTIME, &now_precise);

    fprintf(stderr, "%s.%03ldZ [%s] ", ts, (long)(now_precise.tv_nsec / 1000000L), proc_name);

    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}
