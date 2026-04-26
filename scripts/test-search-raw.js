
import { LLMClient } from '../src/llm-client.js';
import { Database } from '../nVDB/napi/index.js';
import path from 'path';

async function test() {
    const client = new LLMClient();
    await client.waitReady();
    
    // nVDB Setup
    const codebasePath = path.join('D:\\\\DEV\\\\nIndexer_V2\\\\data\\\\codebases', 'nIndexer_V2_SelfTest');
    const db = new Database(path.join(codebasePath, 'nvdb'));
    const collection = db.getCollection('files');
    
    console.log('Embedding query...');
    const query = 'How does the search router rank results?';
    const queryEmbedding = await client.embedText(query);
    
    console.log('Searching collection...');
    const rawResults = collection.search({
        vector: queryEmbedding,
        top_k: 5,
        approximate: true,
        ef: 64
    });
    
    console.log('Raw Result 0:', JSON.stringify(rawResults[0], null, 2));
    process.exit(0);
}
test();
