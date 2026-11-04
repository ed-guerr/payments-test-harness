# payments-test-harness backend
#
# Targets:
#   make            build all three processes into build/
#   make FAULTS=1   fault-injection build (PAY_FAULT=<name> selects at runtime)
#   make check      ASan/UBSan build (build-asan/) + full smoke test
#   make run        start all three processes (logs in build/, pids in build/run.pid)
#   make stop       stop the processes started by `make run`
#   make introspect print each process's message table as JSON
#   make fmt        clang-format all C sources
#   make fmt-check  fail if any C source is not clang-format clean
#   make clean      remove build/

CC        ?= cc
BUILD_DIR ?= build
ASAN      ?= 0
FAULTS    ?= 0

.DEFAULT_GOAL := all

CFLAGS  = -std=c11 -Wall -Wextra -Werror -Iinclude
LDFLAGS = -lsqlite3
ifeq ($(ASAN),1)
  CFLAGS += -g -fsanitize=address,undefined
else
  CFLAGS += -O2
endif
# PAY_FAULTS compiles in the fault branches; without it, fault_active() is a
# constant 0 and the fault code is dropped by the optimizer (see pay/faults.h).
ifeq ($(FAULTS),1)
  CFLAGS += -DPAY_FAULTS
endif

COMMON_SRCS = src/common/log.c \
              src/common/envelope.c \
              src/common/socket.c \
              src/common/db.c \
              src/common/introspect.c \
              src/common/messages.c \
              src/common/args.c \
              src/common/validate.c

OBJS_COMMON = $(COMMON_SRCS:%.c=$(BUILD_DIR)/obj/%.o)
PROCS = pay-orders ledger auth-gateway

$(BUILD_DIR)/pay-orders: $(OBJS_COMMON) $(BUILD_DIR)/obj/src/pay_orders/main.o $(BUILD_DIR)/obj/src/pay_orders/handlers.o
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

$(BUILD_DIR)/ledger: $(OBJS_COMMON) $(BUILD_DIR)/obj/src/ledger/main.o $(BUILD_DIR)/obj/src/ledger/handlers.o
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

$(BUILD_DIR)/auth-gateway: $(OBJS_COMMON) $(BUILD_DIR)/obj/src/auth_gateway/main.o \
                           $(BUILD_DIR)/obj/src/auth_gateway/handlers.o $(BUILD_DIR)/obj/src/auth_gateway/forward.o
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

$(BUILD_DIR)/obj/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c -o $@ $<

-include $(shell find $(BUILD_DIR)/obj -name '*.d' 2>/dev/null)

all: $(addprefix $(BUILD_DIR)/, $(PROCS))

check:
	$(MAKE) BUILD_DIR=build-asan ASAN=1
	python3 tools/smoke_test.py --bin-dir build-asan

run: all
	./run.sh

stop:
	-kill `cat $(BUILD_DIR)/run.pid 2>/dev/null` 2>/dev/null || true

introspect: all
	@for p in $(PROCS); do ./$(BUILD_DIR)/$$p --introspect; echo; done

CLANG_FORMAT ?= $(shell xcrun --find clang-format 2>/dev/null || command -v clang-format 2>/dev/null)
FMT_FILES = $(shell find include src -name '*.h' -o -name '*.c')

fmt:
	@test -n "$(CLANG_FORMAT)" || { echo "clang-format not found (install llvm or Xcode CLT)"; exit 1; }
	$(CLANG_FORMAT) -i $(FMT_FILES)

fmt-check:
	@test -n "$(CLANG_FORMAT)" || { echo "clang-format not found (install llvm or Xcode CLT)"; exit 1; }
	$(CLANG_FORMAT) --dry-run -Werror $(FMT_FILES)

clean:
	rm -rf $(BUILD_DIR)

clean-asan:
	rm -rf build-asan

.PHONY: all check run stop introspect fmt fmt-check clean clean-asan
