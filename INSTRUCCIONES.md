# 1. Quitar la configuración actual (sin credenciales)
claude mcp remove salesforce-metadata-experts -s project

# 2. Volver a añadirla leyendo .secrets en un subshell (las variables no quedan en tu shell)
( source .secrets && \
  MCP_CLIENT_SECRET="$ConsumerSecret" claude mcp add --transport http --scope project \
    --client-id "$ConsumerKey" --client-secret --callback-port 8080 \
    salesforce-metadata-experts \
    https://api.salesforce.com/platform/mcp/v1/d/orgfarm-4feca51f5f-dev-ed/develop/platform/metadata-experts )

# 3. Comprobar
claude mcp get salesforce-metadata-experts
