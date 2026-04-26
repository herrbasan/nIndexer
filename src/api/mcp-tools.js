export const TOOLS_LIST = [
  {
    name: 'list_codebases',
    description: 'List all currently indexed codebases and spaces',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'index_codebase',
    description: 'Index a completely new codebase or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the codebase' },
        source: { type: 'string', description: 'Absolute path to the codebase to index' },
        space: { type: 'string', description: 'Optional workspace category' },
        project: { type: 'string', description: 'Optional project identifier' }
      },
      required: ['name'] // Either name + source, or discoverable roots
    }
  },
  {
    name: 'refresh_codebase',
    description: 'Refresh an existing codebase index by scanning for new/modified/deleted files.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Codebase name to refresh' } },
      required: ['name']
    }
  },
  {
    name: 'search_codebase',
    description: 'Hybrid search (Semantic + Keyword) across a specific codebase. Recommended default search.',
    inputSchema: {
      type: 'object',
      properties: {
        codebase: { type: 'string', description: 'Name of the codebase to search in' },
        query: { type: 'string', description: 'Search term or question' },
        limit: { type: 'number', description: 'Result count (default 10)' },
        strategy: { type: 'string', enum: ['hybrid', 'semantic', 'keyword'], description: 'Strategy to use' }
      },
      required: ['codebase', 'query']
    }
  }
];
