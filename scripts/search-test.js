
import { LLMClient } from '../src/llm-client.js';

async function test() {
  const client = new LLMClient();
  await client.waitReady();
  console.log('Sending query to Llama Embeddings Server:', client.httpUrl);
  try {
     const res = await client.embedBatch(['How does the search router rank results?']);
     console.log('Embedding size:', res[0].length);
     process.exit(0);
  } catch (e) {
     console.error('Llama Error:', e);
  }
}
test();
