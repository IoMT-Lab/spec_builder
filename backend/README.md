# Backend API server for LLM Web App

---

## LLM Script Integration

### How to Use Python (or Other) Scripts for Conversation Logic

1. Place your script(s) in the `llm/` directory (e.g., `llm/conversation_flow.py`).
   - Scripts should accept JSON input via stdin and output JSON to stdout.

2. The backend can call the script using Node.js `child_process`.
   - See `runLLMScript.js` for an example utility.

3. To use a script in the LLM API route:
   - Import and call the script runner in your `/api/llm` handler.
   - Pass user input and session info as needed.

4. Example script input/output:
   - Input: `{ "input": "Hello!", "session": { ... } }`
   - Output: `{ "reply": "[Python Script] You said: Hello!" }`

5. You can add more scripts and select which to use via config or environment variable.

---

### Example Node.js Utility (see `runLLMScript.js`):

```js
const runLLMScript = require('./runLLMScript');

// Usage example in an Express route
app.post('/api/llm', async (req, res) => {
  try {
    const scriptResult = await runLLMScript('../llm/conversation_flow.py', {
      input: req.body.input,
      session: req.body.session || {},
    });
    res.json(scriptResult);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});
```

---

### Tips
- Document your script input/output contract.
- Test scripts independently before integrating.
- Use environment variables or config to select which script to use.
