import { describe, expect, it } from 'vitest';
import { stripResponsesImageGenerationTools } from './responsesCompatibility.js';

describe('stripResponsesImageGenerationTools', () => {
  it('recursively removes Responses image generation tool declarations', () => {
    const input = {
      tools: [
        { type: 'web_search_preview' },
        { type: 'image_generation' },
        { name: 'custom_image_generation_tool', config: { keep: false } },
      ],
      nested: {
        tool: { type: 'image_generation_preview' },
        keep: { type: 'function', name: 'search' },
      },
    };

    const result = stripResponsesImageGenerationTools(input);

    expect(result.removed).toBe(3);
    expect(result.body).toEqual({
      tools: [{ type: 'web_search_preview' }],
      nested: {
        keep: { type: 'function', name: 'search' },
      },
    });
    expect(input.tools).toHaveLength(3);
  });

  it('returns the original shape with removed zero when no image generation declaration exists', () => {
    const input = { tools: [{ type: 'function', name: 'lookup' }], model: 'gpt-5.2' };

    const result = stripResponsesImageGenerationTools(input);

    expect(result.removed).toBe(0);
    expect(result.body).toEqual(input);
  });
});
