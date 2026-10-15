import type { ProviderAdapter } from "./types.ts";

export class ProviderRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    const id = adapter.id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
      throw new Error(`Invalid provider adapter id: ${adapter.id}`);
    }
    if (this.#adapters.has(id)) {
      throw new Error(`Provider adapter already registered: ${id}`);
    }
    this.#adapters.set(id, adapter);
    return this;
  }

  get(id: string): ProviderAdapter | undefined {
    return this.#adapters.get(id.toLowerCase());
  }

  list(): ProviderAdapter[] {
    return [...this.#adapters.values()];
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      this.list().map((adapter) => adapter.dispose?.()),
    );
  }
}
