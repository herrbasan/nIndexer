
import { IndexingService } from '../src/services/indexing.service.js';
import { LLMClient } from '../src/llm-client.js';

async function test() {
    try {
        const client = new LLMClient();
        await client.waitReady();
        
        const indexingService = new IndexingService(client);
        
        console.log('1. removing nIndexer_V2_SelfTest');
        indexingService.removeCodebase('nIndexer_V2_SelfTest');
        
        console.log('2. indexing D:\\\\DEV\\\\nIndexer_V2');
        const res = await indexingService.indexCodebase(
            'nIndexer_V2_SelfTest',
            'D:\\\\DEV\\\\nIndexer_V2',
            (prog) => console.log(prog.status, prog.progress*100, '%')
        );
        
        console.log('Indexing result:', res.payload);
        
        console.log('3. Searching codebase...');
        const searchRes = await indexingService.searchCodebase(
            'nIndexer_V2_SelfTest',
            'How does the search router rank results?',
            'hybrid',
            10
        );
        
        console.log('Search Results:', JSON.stringify(searchRes, null, 2));
        process.exit(0);

    } catch (e) {
        console.error('Test Failed', e);
        process.exit(1);
    }
}
test();
