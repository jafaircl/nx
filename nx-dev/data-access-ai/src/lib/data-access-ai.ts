// based on:
// https://github.com/supabase-community/nextjs-openai-doc-search/blob/main/pages/api/vector-search.ts

import { createClient } from '@supabase/supabase-js';
import GPT3Tokenizer from 'gpt3-tokenizer';
import {
  Configuration,
  OpenAIApi,
  CreateModerationResponse,
  CreateEmbeddingResponse,
  CreateCompletionResponseUsage,
} from 'openai';
import {
  ApplicationError,
  ChatItem,
  PageSection,
  UserError,
  checkEnvVariables,
  getListOfSources,
  getMessageFromResponse,
  initializeChat,
  sanitizeLinksInResponse,
  toMarkdownList,
} from './utils';

const DEFAULT_MATCH_THRESHOLD = 0.78;
const DEFAULT_MATCH_COUNT = 15;
const MIN_CONTENT_LENGTH = 50;

// This limits history to 30 messages back and forth
// It's arbitrary, but also generous
// History length should be based on token count
// This is a temporary solution
const MAX_HISTORY_LENGTH = 30;

const openAiKey = process.env['NX_OPENAI_KEY'];
const supabaseUrl = process.env['NX_NEXT_PUBLIC_SUPABASE_URL'];
const supabaseServiceKey = process.env['NX_SUPABASE_SERVICE_ROLE_KEY'];
const config = new Configuration({
  apiKey: openAiKey,
});
const openai = new OpenAIApi(config);

let chatFullHistory: ChatItem[] = [];

let totalTokensSoFar = 0;

export async function nxDevDataAccessAi(
  query: string,
  aiResponse?: string
): Promise<{
  textResponse: string;
  usage?: CreateCompletionResponseUsage;
  sources: { heading: string; url: string }[];
  sourcesMarkdown: string;
}> {
  if (chatFullHistory.length > MAX_HISTORY_LENGTH) {
    chatFullHistory.slice(0, MAX_HISTORY_LENGTH - 4);
  }

  try {
    checkEnvVariables(openAiKey, supabaseUrl, supabaseServiceKey);

    if (!query) {
      throw new UserError('Missing query in request data');
    }

    const supabaseClient = createClient(
      supabaseUrl as string,
      supabaseServiceKey as string
    );

    // Moderate the content to comply with OpenAI T&C
    const sanitizedQuery = query.trim();
    const moderationResponse: CreateModerationResponse = await openai
      .createModeration({ input: sanitizedQuery })
      .then((res) => res.data);

    const [results] = moderationResponse.results;

    if (results.flagged) {
      throw new UserError('Flagged content', {
        flagged: true,
        categories: results.categories,
      });
    }

    // Create embedding from query
    // NOTE: Here, we may or may not want to include the previous AI response
    /**
     * For retrieving relevant Nx documentation sections via embeddings, it's a design decision.
     * Including the prior response might give more contextually relevant sections,
     * but just sending the query might suffice for many cases.
     *
     * We can experiment with this.
     *
     * How the solution looks like with previous response:
     *
     *     const embeddingResponse = await openai.createEmbedding({
     *         model: 'text-embedding-ada-002',
     *         input: sanitizedQuery + aiResponse,
     *       });
     *
     * This costs more tokens, so if we see conts skyrocket we remove it.
     * As it says in the docs, it's a design decision, and it may or may not really improve results.
     */
    const embeddingResponse = await openai.createEmbedding({
      model: 'text-embedding-ada-002',
      input: sanitizedQuery + aiResponse,
    });

    if (embeddingResponse.status !== 200) {
      throw new ApplicationError(
        'Failed to create embedding for question',
        embeddingResponse
      );
    }

    const {
      data: [{ embedding }],
    }: CreateEmbeddingResponse = embeddingResponse.data;

    const { error: matchError, data: pageSections } = await supabaseClient.rpc(
      'match_page_sections_2',
      {
        embedding,
        match_threshold: DEFAULT_MATCH_THRESHOLD,
        match_count: DEFAULT_MATCH_COUNT,
        min_content_length: MIN_CONTENT_LENGTH,
      }
    );

    if (matchError) {
      throw new ApplicationError('Failed to match page sections', matchError);
    }

    // Note: this is experimental. I think it should work
    // mainly because we're testing previous response + query.
    if (!pageSections || pageSections.length === 0) {
      throw new UserError(
        'Nothing relevant found in the Nx documentation! Please try another query.'
      );
    }

    const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });
    let tokenCount = 0;
    let contextText = '';

    for (let i = 0; i < (pageSections as PageSection[]).length; i++) {
      const pageSection: PageSection = pageSections[i];
      const content = pageSection.content;
      const encoded = tokenizer.encode(content);
      tokenCount += encoded.text.length;

      if (tokenCount >= 2500) {
        break;
      }

      contextText += `${content.trim()}\n---\n`;
    }

    const prompt = `
      ${`
      You are a knowledgeable Nx representative. 
      Your knowledge is based entirely on the official Nx Documentation. 
      You can answer queries using ONLY that information.
      You cannot answer queries using your own knowledge or experience.
      Answer in markdown format. Always give an example, answer as thoroughly as you can, and
      always provide a link to relevant documentation
      on the https://nx.dev website. All the links you find or post 
      that look like local or relative links, always prepend with "https://nx.dev".
      Your answer should be in the form of a Markdown article 
      (including related code snippets if available), much like the
      existing Nx documentation. Mark the titles and the subsections with the appropriate markdown syntax.
      If you are unsure and cannot find an answer in the Nx Documentation, say
      "Sorry, I don't know how to help with that. You can visit the [Nx documentation](https://nx.dev/getting-started/intro) for more info."
      Remember, answer the question using ONLY the information provided in the Nx Documentation.
      `
        .replace(/\s+/g, ' ')
        .trim()}
    `;

    const { chatMessages: chatGptMessages, chatHistory } = initializeChat(
      chatFullHistory,
      query,
      contextText,
      prompt,
      aiResponse
    );

    chatFullHistory = chatHistory;

    const response = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo-16k',
      messages: chatGptMessages,
      temperature: 0,
      stream: false,
    });

    if (response.status !== 200) {
      const error = response.data;
      throw new ApplicationError('Failed to generate completion', error);
    }

    const message = getMessageFromResponse(response.data);

    const responseWithoutBadLinks = await sanitizeLinksInResponse(message);

    const sources = getListOfSources(pageSections);

    totalTokensSoFar += response.data.usage?.total_tokens ?? 0;

    return {
      textResponse: responseWithoutBadLinks,
      usage: response.data.usage,
      sources,
      sourcesMarkdown: toMarkdownList(sources),
    };
  } catch (err: unknown) {
    if (err instanceof UserError) {
      console.error(err.message);
    } else if (err instanceof ApplicationError) {
      // Print out application errors with their additional data
      console.error(`${err.message}: ${JSON.stringify(err.data)}`);
    } else {
      // Print out unexpected errors as is to help with debugging
      console.error(err);
    }

    // TODO: include more response info in debug environments
    console.error(err);
    throw err;
  }
}

export function resetHistory() {
  chatFullHistory = [];
  totalTokensSoFar = 0;
}

export function getHistory(): ChatItem[] {
  return chatFullHistory;
}
