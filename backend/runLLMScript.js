const { spawn } = require('child_process');

// Run a Python script for LLM conversation logic
// scriptPath: path to the Python script (e.g., '../llm/conversation_flow.py')
// inputObj: object to send as JSON to the script's stdin
// Returns a Promise that resolves to the script's JSON output
function runLLMScript(scriptPath, inputObj) {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [scriptPath]);
    let output = '';
    let error = '';
    py.stdout.on('data', data => output += data);
    py.stderr.on('data', data => error += data);
    py.on('close', code => {
      if (code !== 0) {
        // Log both output and error for debugging
        console.error('Python script exited with code', code);
        if (output) console.error('Python stdout:', output);
        if (error) console.error('Python stderr:', error);
        // Return both output and error in the rejection
        return reject({
          message: 'Script error',
          code,
          stdout: output,
          stderr: error
        });
      }
      try {
        resolve(JSON.parse(output));
      } catch (e) {
        // Log output and error if JSON parsing fails
        console.error('Invalid JSON from script');
        if (output) console.error('Python stdout:', output);
        if (error) console.error('Python stderr:', error);
        reject({
          message: 'Invalid JSON from script',
          stdout: output,
          stderr: error
        });
      }
    });
    py.stdin.write(JSON.stringify(inputObj));
    py.stdin.end();
  });
}

module.exports = runLLMScript;
