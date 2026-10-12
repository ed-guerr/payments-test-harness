#pragma once

#include "pay/message.h"

int handle_transfer_funds(Server *srv, int client, const Envelope *env);
int handle_reverse_transfer(Server *srv, int client, const Envelope *env);
