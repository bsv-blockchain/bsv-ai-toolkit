#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { execa } from 'execa'; // Hopefully found now
import path from 'path';
import fs from 'fs';

// --- Configuration & Environment Check ---
const BSV_REPOS_DIR = process.env.BSV_REPOS_DIR;
if (!BSV_REPOS_DIR || !fs.existsSync(BSV_REPOS_DIR)) {
    console.error(`ERROR: BSV_REPOS_DIR environment variable is not set or points to a non-existent directory.`);
    console.error(`Please set BSV_REPOS_DIR to the absolute path containing the cloned BSV repositories.`);
    console.error(`Current value: ${BSV_REPOS_DIR}`);
    process.exit(1);
}
console.error(`Using repository directory: ${BSV_REPOS_DIR}`);

// --- Server Definition ---
const server = new McpServer({
    name: "@bsv/mcp",
    version: "1.0.8",
}, {
    capabilities: { tools: {}, prompts: {} },
});
console.error("BSV Developer Server initializing...");

// --- Helper Function for Search (Keep as is) ---
async function runSearch(searchDir: string, query: string, filePattern: string = '*'): Promise<string> {
    // ... (implementation unchanged) ...
    const command = 'rg';
    const args = [ '--color=never', '--line-number', '--max-count=1', '-g', filePattern, '-e', query, '.' ];
    try {
        console.error(`Running search in ${searchDir}: ${command} ${args.join(' ')}`);
        const { stdout, stderr, failed } = await execa(command, args, { cwd: searchDir, reject: false });
        if (failed) {
             if (stderr.includes('command not found') || stderr.includes('ENOENT')) {
                 console.error("Warning: 'rg' (ripgrep) not found. Falling back to 'grep'. Install ripgrep for better performance.");
                 const grepArgs = [ '-r', '-n', '-I', '-e', query, '.' ];
                 console.error(`Falling back to: grep ${grepArgs.join(' ')} in ${searchDir}`);
                 const { stdout: grepStdout, failed: grepFailed } = await execa('grep', grepArgs, { cwd: searchDir, reject: false });
                 if (grepFailed) return `Grep search failed or found no matches for "${query}".`;
                 return grepStdout.trim() || `No matches found for "${query}" using grep.`;
             } else {
                console.error(`Search command failed: ${stderr}`);
                return `Search command failed or found no matches for "${query}".`;
             }
        }
        return stdout.trim() || `No matches found for "${query}" using ${command}.`;
    } catch (error: any) {
        console.error(`Error executing search command: ${error.message}`);
        if (error.code === 'ENOENT') return `Error: Search command '${command}' not found. Please install ripgrep (recommended) or ensure grep is in PATH.`;
        return `Error during search: ${error.message}`;
    }
}

// --- Tool Implementations ---

// Tool 1: BRC Lookup (Modified)
server.tool(
    "brc_lookup",
    "Retrieve the content of a specific BRC (Bitcoin Request for Comment) from the local clone of bitcoin-sv/BRCs repository.",
    { brc_identifier: z.string().describe("...") }, // Inlined schema
    async ({ brc_identifier }) => {
        console.error(`Tool call: brc_lookup with identifier: ${brc_identifier}`);
        
        try {
            // Use the local BRCs repository directory from environment variable
            const brcsRepoPath = path.join(BSV_REPOS_DIR, 'BRCs');
            
            // Check if the BRCs directory exists
            if (!fs.existsSync(brcsRepoPath)) {
                throw new Error(`BRCs repository directory not found at ${brcsRepoPath}. Ensure you've cloned the repository.`);
            }
            
            // Define potential category directories to search
            const categories = [
                '', // Try root directory first
                'apps/',
                'key-derivation/',
                'opinions/',
                'outpoints/',
                'overlays/',
                'payments/',
                'peer-to-peer/',
                'transactions/',
                'tokens/',
                'wallet/'
            ];
            
            // --- Start of new logic for BRC identifier variants ---
            const potentialIdentifiers = new Set<string>();
            potentialIdentifiers.add(brc_identifier); // Add original input

            // Add normalized version (e.g., "1" from "0001")
            const normalizedId = brc_identifier.replace(/^0+/, '');
            potentialIdentifiers.add(normalizedId);

            // Add 4-digit zero-padded version if input is numeric (e.g., "0001" from "1")
            if (/^\d+$/.test(brc_identifier)) {
                const num = parseInt(brc_identifier, 10);
                // Pad to 4 digits. e.g., 1 -> "0001", 12 -> "0012"
                const paddedId = String(num).padStart(4, '0');
                potentialIdentifiers.add(paddedId);
            }
            // --- End of new logic for BRC identifier variants ---
            
            // Try each possible directory and identifier combination
            for (const category of categories) {
                for (const id of Array.from(potentialIdentifiers)) { // Iterate over the generated set
                    const fileNameGuess = `${id}.md`;
                    const filePath = path.join(brcsRepoPath, category, fileNameGuess);
                    
                    console.error(`Looking for BRC file at: ${filePath}`);
                    
                    // Check if the file exists
                    if (fs.existsSync(filePath)) {
                        // Read the file content
                        const content = fs.readFileSync(filePath, 'utf8');
                        console.error(`Successfully found BRC ${id} at ${filePath}`);
                        return { content: [{ type: "text", text: content } satisfies TextContent], };
                    }
                }
            }
            
            // If we reached here, all attempts failed
            throw new Error(`Could not find BRC ${brc_identifier} in any known directory. The BRC may not exist or might be in an unexpected location.`);
        } catch (error: any) {
            console.error(`Error in brc_lookup: ${error.message}`);
            return { isError: true, content: [{ type: "text", text: `Error fetching BRC ${brc_identifier}: ${error.message}` } satisfies TextContent], };
        }
    }
);


// Tool 2: Code Search (Keep as is with inlined schema)
server.tool(
    "code_search",
    "Search for code snippets...",
    { // Inlined schema
        query: z.string().describe("..."),
        repository_name: z.string().optional().describe("..."),
        file_extension: z.string().optional().describe("..."),
    },
    async ({ query, repository_name, file_extension }) => { /* ... implementation unchanged ... */
        console.error(`Tool call: code_search query='${query}', repo='${repository_name}', ext='${file_extension}'`);
        let searchDirectory = BSV_REPOS_DIR!;
        if (repository_name) {
            const repoPath = path.join(searchDirectory, repository_name);
            if (!fs.existsSync(repoPath)) return { isError: true, content: [{ type: 'text', text: `Error: Repository directory not found: ${repoPath}` }], };
            searchDirectory = repoPath;
        }
        const filePattern = file_extension ? file_extension : '*';
        try {
            const results = await runSearch(searchDirectory, query, filePattern);
             return { content: [{ type: 'text', text: results }], };
        } catch (error: any) {
             return { isError: true, content: [{ type: 'text', text: `Error running code search: ${error.message}` }], };
        }
     }
);

// Tool 3: Find Function Definition (Keep as is with inlined schema)
server.tool(
    "find_function_definition",
    "Locate potential definitions...",
    { // Inlined schema
        function_name: z.string().describe("..."),
        repository_name: z.string().optional().describe("..."),
    },
    async ({ function_name, repository_name }) => { /* ... implementation unchanged ... */
         console.error(`Tool call: find_function_definition name='${function_name}', repo='${repository_name}'`);
         let searchDirectory = BSV_REPOS_DIR!;
         let repoSubPath = '';
         if (repository_name) {
            repoSubPath = repository_name;
            const repoPath = path.join(searchDirectory, repository_name);
            if (!fs.existsSync(repoPath)) return { isError: true, content: [{ type: 'text', text: `Error: Repository directory not found: ${repoPath}` }], };
            searchDirectory = repoPath;
        }
        const patterns = [ `function\\s+${function_name}[\\s(]`, `def\\s+${function_name}[\\s(:]`, `const\\s+${function_name}\\s*=`, `let\\s+${function_name}\\s*=`, `var\\s+${function_name}\\s*=`, `class\\s+\\w+\\s*{[^}]*${function_name}\\s*\\(`, `${function_name}\\s*:\\s*function`, `${function_name}\\s*\\(`, ];
        const combinedPattern = patterns.join('|');
        try {
            const srcDirs = ['src', 'lib', 'source', '.'];
            let results = ''; let found = false;
            for (const dir of srcDirs) {
                const currentSearchDir = path.join(searchDirectory, dir);
                if (fs.existsSync(currentSearchDir)){
                     results = await runSearch(currentSearchDir, combinedPattern, '*.{ts,js,py,go,rs,java}');
                     if (!results.startsWith("No matches found") && !results.startsWith("Error") && !results.startsWith("Grep search failed")) { found = true; break; }
                }
            }
            if(!found) results = await runSearch(searchDirectory, combinedPattern, '*.{ts,js,py,go,rs,java}');
            if (repoSubPath && !results.startsWith("No matches") && !results.startsWith("Error")) {
                results = results.split('\n').map(line => line.includes(':') ? `${repoSubPath}/${line}` : line ).join('\n');
            }
             return { content: [{ type: 'text', text: results }], };
        } catch (error: any) {
             return { isError: true, content: [{ type: 'text', text: `Error running find definition: ${error.message}` }], };
        }
     }
);


// --- Prompt Implementations ---

// *** FIX: Restore FULL definitions for ALL prompts ***

// Prompt 1: Summarize BRC
server.prompt(
    "/summarize_brc",
    "Summarize a specific BRC.",
    {
        brc_identifier: z.string().describe("The BRC number or identifier (e.g., '0001')."),
    },
    ({ brc_identifier }) => {
        console.error(`Prompt request: /summarize_brc for ${brc_identifier}`);
        const fileNameGuess = `${brc_identifier}.md`; // Needs robust mapping
        const resourceUri = `file://${path.join(BSV_REPOS_DIR!, 'BRCs', 'brcs', fileNameGuess).replace(/\\/g, '/')}`;
        const instructionMessage = `Please summarize BRC-${brc_identifier}. The content should be available in the attached resource (if possible, use this URI): ${resourceUri}`;
        return {
            messages: [{ role: "user", content: { type: "text", text: instructionMessage } }],
        };
    }
);

// Prompt 2: Explain Code
server.prompt(
  '/explain_code',
  'Explain a selected piece of code from a BSV repository.',
  {
      code_reference: z.string().describe('The file URI (e.g., file:///path/to/repo/file.ts) of the code to explain. Optionally include #L10-L20 for line numbers.')
  },
  ({ code_reference }) => {
     console.error(`Prompt request: /explain_code for ${code_reference}`);
    return {
      messages: [{ role: 'user', content: { type: 'text', text: `Please explain the code identified by the resource URI: ${code_reference}. The client should provide the file content.` } }]
    };
  }
);

// Prompt 3: Generate Usage Example
server.prompt(
  '/generate_usage_example',
  'Generate an example showing how to use a specific function or feature from one of the SDKs (ts-sdk, py-sdk, wallet-toolbox).',
  {
      feature_description: z.string().describe('Description of the function or feature (e.g., "wallet-toolbox createKey", "ts-sdk transaction signing").'),
      sdk_preference: z.string().optional().describe("Optional: Preferred SDK ('ts-sdk', 'py-sdk', 'wallet-toolbox')."),
  },
  ({ feature_description, sdk_preference }) => {
    console.error(`Prompt request: /generate_usage_example for '${feature_description}', preference: ${sdk_preference || 'any'}`);
    let message = `Please generate a usage example for the following BSV feature: "${feature_description}".`;
    if (sdk_preference) {
        message += ` Please provide the example for the ${sdk_preference}.`;
        if (sdk_preference === 'ts-sdk') message += ` You might find relevant code in the 'ts-sdk' repository, possibly in its 'src' or 'examples' directory.`;
        else if (sdk_preference === 'py-sdk') message += ` You might find relevant code in the 'py-sdk' repository, possibly in its main package or 'examples' directory.`;
        else if (sdk_preference === 'wallet-toolbox') message += ` You might find relevant code in the 'wallet-toolbox' or 'wallet-toolbox-examples' repositories.`;
    } else {
        message += ` You can choose the most relevant SDK (ts-sdk, py-sdk, wallet-toolbox). Consider checking their respective 'src', 'lib', or 'examples' directories for context.`
    }
    message += ` The client should attach relevant source file context if possible.`
    return {
      messages: [{ role: 'user', content: { type: 'text', text: message } }]
    };
  }
);

// Prompt 4: Find Related Code
server.prompt(
  '/find_related_code',
  'Find code related to a specific concept or feature across the repositories.',
  {
      concept: z.string().describe('The feature or concept to search for (e.g., "transaction signing", "metanet node creation").')
  },
  ({ concept }) => {
     console.error(`Prompt request: /find_related_code for '${concept}'`);
    return {
      messages: [{ role: 'user', content: { type: 'text', text: `Please find code snippets related to "${concept}" across the relevant BSV repositories. Use the 'code_search' tool.` } }]
    };
  }
);


// --- Server Execution (Keep as is) ---
async function main() {
    console.error("BSV Dev Server: main() function entered.");
    const transport = new StdioServerTransport();
    console.error("BSV Dev Server: StdioServerTransport created.");
    console.error("BSV Dev Server: Attempting server.connect(transport)...");
    await server.connect(transport);
    console.error("BSV Dev Server: server.connect() completed. Server running via stdio.");
}

main().catch((error) => {
    console.error("BSV Dev Server: Error during main() execution:", error);
    process.exit(1);
});