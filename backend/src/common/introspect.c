#include <stdio.h>
#include <string.h>

#include "pay/introspect.h"

static void json_write_string(const char *s)
{
    fputc('"', stdout);
    for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; p++)
    {
        switch (*p)
        {
            case '"':
                fputs("\\\"", stdout);
                break;
            case '\\':
                fputs("\\\\", stdout);
                break;
            case '\n':
                fputs("\\n", stdout);
                break;
            case '\t':
                fputs("\\t", stdout);
                break;
            case '\r':
                fputs("\\r", stdout);
                break;
            default:
                if (*p < 0x20)
                    printf("\\u%04x", *p);
                else
                    fputc(*p, stdout);
                break;
        }
    }
    fputc('"', stdout);
}

void introspect_print(const char *process, uint16_t port, const MessageDef *table, size_t n_msgs)
{
    printf("{\n");
    printf("  \"process\": ");
    json_write_string(process);
    printf(",\n");
    printf("  \"listen\": \"127.0.0.1:%u\",\n", port);
    printf("  \"messages\": [\n");

    for (size_t i = 0; i < n_msgs; i++)
    {
        const MessageDef *def = &table[i];

        printf("    {\n");
        printf("      \"id\": %u,\n", def->id);
        printf("      \"name\": ");
        json_write_string(def->name);
        printf(",\n");
        printf("      \"direction\": ");
        json_write_string(def->direction);
        printf(",\n");
        printf("      \"size\": %zu,\n", def->struct_size);
        printf("      \"response\": %u,\n", def->response_id);
        printf("      \"fields\": [\n");

        size_t n = field_count(def->fields);
        for (size_t j = 0; j < n; j++)
        {
            const FieldDef *f = &def->fields[j];
            printf("        {\"name\": ");
            json_write_string(f->name);
            printf(", \"type\": ");
            json_write_string(f->type);
            printf(", \"size\": %zu, \"offset\": %zu}", f->size, f->offset);
            if (j + 1 < n)
                fputc(',', stdout);
            fputc('\n', stdout);
        }

        printf("      ]\n");
        printf("    }%s\n", i + 1 < n_msgs ? "," : "");
    }

    printf("  ]\n");
    printf("}\n");
}
