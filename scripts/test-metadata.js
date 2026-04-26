
import { SimpleMetadataStore } from '../src/services/metadata.service.js';
import path from 'path';

async function test() {
    const store = new SimpleMetadataStore('D:\\\\DEV\\\\nIndexer_V2\\\\data\\\\codebases\\\\nIndexer_V2_SelfTest');
    await store.init();
    const info = await store.getFile('src/services/search-router.service.js');
    console.log('Metadata Info (unix path):', info);
    
    const infoWin = await store.getFile('src\\\\services\\\\search-router.service.js');
    console.log('Metadata Info (win path):', infoWin);

    // Let's print out some keys
    const allPaths = Array.from(store.files.keys());
    console.log('Sample paths:', allPaths.slice(0, 5));
}
test();
