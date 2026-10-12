#pragma once

#include "pay/message.h"

int handle_authorize(Server *srv, int client, const Envelope *env);
int handle_settle(Server *srv, int client, const Envelope *env);
