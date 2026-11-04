#define _POSIX_C_SOURCE 200809L

#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "pay/validate.h"

int validate_payload(const MessageDef *def, const void *payload)
{
    const uint8_t *base = (const uint8_t *)payload;

    for (size_t i = 0; def->fields[i].name != NULL; i++)
    {
        const FieldDef *f = &def->fields[i];
        const uint8_t *p = base + f->offset;

        if (strncmp(f->type, "char[", 5) == 0)
        {
            if (memchr(p, '\0', f->size) == NULL)
                return -1;
        }
        else if (f->size == 4 && strcmp(f->name, "amount_cents") == 0)
        {
            /* Little-endian wire format; read byte-wise (no alignment
             * assumptions). */
            uint32_t amount = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
                              ((uint32_t)p[3] << 24);
            if (amount < 1 || amount > (uint32_t)INT32_MAX)
                return -1;
        }
    }

    return 0;
}
