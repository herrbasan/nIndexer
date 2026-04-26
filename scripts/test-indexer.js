
import fs from 'fs';

async function test() {
    try {
        console.log('Connecting to SSE...');
        const sseRes = await fetch('http://localhost:3666/mcp/sse', {
            headers: { 'Accept': 'text/event-stream' }
        });
        
        let endpoint = null;
        let resolveEndpoint = null;
        const endpointPromise = new Promise(r => resolveEndpoint = r);
        let activeEndpoint = null;

        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        
        // Listen asynchronously
        (async () => {
            let buffer = '';
            while (true) {
                const {value, done} = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value);
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep remainder
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('event: endpoint')) {
                        const dataLine = lines[i+1];
                        if (dataLine.startsWith('data: ')) {
                            endpoint = dataLine.substring(6);
                            resolveEndpoint(endpoint);
                            i++; // skip next line
                        }
                    } else if (line.startsWith('event: message')) {
                        const dataLine = lines[i+1];
                        if (dataLine && dataLine.startsWith('data: ')) {
                            const msg = JSON.parse(dataLine.substring(6));
                            if (msg.method === 'notifications/progress') {
                                console.log('Progress:', msg.params.progress, '%');
                            } else if (msg.id === 2 && msg.result) {
                                console.log('Indexing result:', msg.result.content[0].text);
                                await testSearch(activeEndpoint);
                            } else if (msg.id === 3 && msg.result) {
                                console.log('================ SEARCH RESULTS ================');
                                console.log(msg.result.content[0].text);
                                process.exit(0);
                            }
                        }
                        i++;
                    }
                }
            }
        })();
        
        endpoint = await endpointPromise;
        activeEndpoint = 'http://localhost:3666' + endpoint;
        console.log('Got message endpoint:', activeEndpoint);

        console.log('1. Sending remove_codebase...');
        await fetch(activeEndpoint, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'tools/call',
                params: { name: 'refresh_codebase', arguments: { name: 'nIndexer_V2_SelfTest' } }
            })
        });

        console.log('2. Sending index_codebase...');
        await fetch(activeEndpoint, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                jsonrpc: '2.0', id: 2, method: 'tools/call',
                params: { name: 'index_codebase', arguments: { name: 'nIndexer_V2_SelfTest', source: 'D:\\\\DEV\\\\nIndexer_V2' } }
            })
        });

    } catch (e) {
        console.error('Test Failed:', e);
        process.exit(1);
    }
}

async function testSearch(endpoint) {
    console.log('3. Sending search_codebase...');
    await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'search_codebase', arguments: { codebase: 'nIndexer_V2_SelfTest', query: 'How does the search router rank results?', strategy: 'hybrid', limit: 5 } }
        })
    });
}

test();
