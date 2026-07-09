const IMAGE_GENERATION_TOOL_TYPES = new Set([
  'image_generation',
  'image_generation_call',
  'image_generation_preview',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isImageGenerationToolDeclaration(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  const name = typeof value.name === 'string' ? value.name.trim().toLowerCase() : '';
  return IMAGE_GENERATION_TOOL_TYPES.has(type) || name.includes('image_generation');
}

function stripValue(value: unknown): { value: unknown; removed: number; shouldDrop: boolean } {
  if (isImageGenerationToolDeclaration(value)) {
    return { value: undefined, removed: 1, shouldDrop: true };
  }

  if (Array.isArray(value)) {
    let removed = 0;
    const next: unknown[] = [];
    for (const item of value) {
      const stripped = stripValue(item);
      removed += stripped.removed;
      if (!stripped.shouldDrop) next.push(stripped.value);
    }
    return { value: next, removed, shouldDrop: false };
  }

  if (isRecord(value)) {
    let removed = 0;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const stripped = stripValue(child);
      removed += stripped.removed;
      if (!stripped.shouldDrop) next[key] = stripped.value;
    }
    return { value: next, removed, shouldDrop: false };
  }

  return { value, removed: 0, shouldDrop: false };
}

export function stripResponsesImageGenerationTools(body: unknown): { body: unknown; removed: number } {
  const stripped = stripValue(body);
  return { body: stripped.value, removed: stripped.removed };
}
