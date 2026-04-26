import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdioScript = path.join(__dirname, '../src/mcp-stdio.js');

console.log(`Spawning MCP stdio server: node ${stdioScript}`);
const mcpProcess = spawn('node', [stdioScript], {
    stdio: ['pipe', 'pipe', 'inherit'] // pipe stdin and stdout, inherit stderr for logs
});

let outputBuffer = '';

mcpProcess.stdout.on('data', (data) => {
    const chunk = data.toString();
    outputBuffer += chunk;
    
    // Process full lines
    let newlineIndex;
    while ((newlineIndex = outputBuffer.indexOf('\n')) !== -1) {
        const line = outputBuffer.slice(0, newlineIndex).trim();
        outputBuffer = outputBuffer.slice(newlineIndex + 1);
        
        if (line) {
            try {
                const message = JSON.parse(line);
                console.log('\n✅ Received JSON-RPC Response from stdout:');
                console.log(JSON.stringify(message, null, 2));
                
                // Exit after receiving the response
                console.log('\nTest successful. Shutting down...');
                mcpProcess.kill();
                process.exit(0);
            } catch (err) {
                console.error('Failed to parse stdout line as JSON:', line);
            }
        }
    }
});

mcpProcess.on('error', (err) => {
    console.error('Failed to start subprocess:', err);
    process.exit(1);
});

// Wait a second for the server to initialize
setTimeout(() => {
    const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
    };
    
    const requestStr = JSON.stringify(request) + '\n';
    console.log(`\n📤 Sending JSON-RPC Request to stdin:\n${requestStr.trim()}`);
    mcpProcess.stdin.write(requestStr);
}, 2000);
