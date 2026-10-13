#!/usr/bin/env bash
# Wrapper: corre o MCP stdio do LookaBerry a partir de ~/LookaBerry para que o
# dotenv.config() do src/config/env.ts encontre o .env correto (procura no cwd).
# Sem isto, o Hermes spawna o stdio a partir do cwd DELE e o .env não é lido.
cd "$(dirname "$0")" || exit 1
exec node dist/src/mcp/transports/stdio.js
