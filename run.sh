curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <AI_TOKEN>" \
  -d '{
    "model": "gpt-5",
    "tools": [
      {
        "type": "mcp",
        "server_label": "training",
        "server_url": "https://phoenix-ended-paso-membrane.trycloudflare.com/mcp",
        "headers": { "Authorization": "Bearer demo_user" },
        "require_approval": "never"
      }
    ],
    "input": "Luo ohjelma käyttäjän speksillä: 3 treeniä viikossa, 60 min, tavoite lenkki ja aerobinen urheilu, ei vaivoja. Käytä MCP-työkalua create_program. Palauta vain summary_text."
  }'