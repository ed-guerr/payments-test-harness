#pragma once

#include <stdlib.h>
#include <string.h>

/*
 * Compile-gated fault injection (mutation check).
 *
 * `make FAULTS=1` defines PAY_FAULTS and compiles the fault branches into the
 * binaries; `PAY_FAULT=<name>` then selects one fault at runtime (unset or
 * empty means normal behavior). Without the define, fault_active() is a
 * constant 0 and the optimizer drops the fault code entirely, so a normal
 * build cannot be influenced by the environment.
 */
#ifdef PAY_FAULTS
static inline int fault_active(const char *name)
{
    const char *sel = getenv("PAY_FAULT");
    return sel != NULL && sel[0] != '\0' && strcmp(sel, name) == 0;
}
#else
static inline int fault_active(const char *name)
{
    (void)name;
    return 0;
}
#endif
