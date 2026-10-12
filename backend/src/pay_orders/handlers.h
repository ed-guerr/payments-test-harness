#pragma once

#include "pay/message.h"

int handle_create_payment(Server *srv, int client, const Envelope *env);
int handle_cancel_payment(Server *srv, int client, const Envelope *env);
int handle_complete_payment(Server *srv, int client, const Envelope *env);
