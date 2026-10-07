import type { Provider, ModelConfig } from '../../shared/types.js'
import type { PluginModelMetadataProvider, PluginModelMetadata } from '../../plugin/index.js'

let providers: PluginModelMetadataProvider[] = []

export function setPluginModelMetadataProviders(next: PluginModelMetadataProvider[]): void {
  providers = [...next]
}

export function listPluginModelMetadataProviders(): PluginModelMetadataProvider[] {
  return [...providers]
}

async function fetchMetadata(
  call: () => PluginModelMetadata | undefined | Promise<PluginModelMetadata | undefined>,
): Promise<PluginModelMetadata | undefined> {
  try {
    return await call()
  } catch {
    return undefined
  }
}

function mergeCommonMetadata(
  merged: PluginModelMetadata,
  badges: NonNullable<PluginModelMetadata['badges']>,
  metadata: PluginModelMetadata,
): void {
  if (metadata.extra !== undefined) merged.extra = { ...(merged.extra ?? {}), ...metadata.extra }
  if (metadata.badges) badges.push(...metadata.badges)
}

export async function enrichModelWithPluginMetadata(providerId: string, model: ModelConfig): Promise<ModelConfig> {
  if (providers.length === 0) return model
  const merged: PluginModelMetadata = {}
  const badges: NonNullable<PluginModelMetadata['badges']> = []
  for (const provider of providers) {
    const metadata = await fetchMetadata(() => provider.getMetadata({ providerId, modelId: model.id, model }))
    if (!metadata) continue
    if (metadata.contextWindow !== undefined) merged.contextWindow = metadata.contextWindow
    if (metadata.vision !== undefined) merged.vision = metadata.vision
    if (metadata.reasoning !== undefined) merged.reasoning = metadata.reasoning
    if (metadata.nameTone !== undefined) merged.nameTone = metadata.nameTone
    if (metadata.popover !== undefined) merged.popover = metadata.popover
    if (metadata.subline !== undefined) merged.subline = metadata.subline
    if (metadata.bottomSubline !== undefined) merged.bottomSubline = metadata.bottomSubline
    mergeCommonMetadata(merged, badges, metadata)
  }
  if (badges.length > 0) merged.badges = badges
  if (Object.keys(merged).length === 0) return model
  return { ...model, pluginMetadata: merged }
}

export async function enrichProviderWithPluginMetadata(provider: Provider): Promise<Provider> {
  if (providers.length === 0) return provider
  const merged: PluginModelMetadata = {}
  const badges: NonNullable<PluginModelMetadata['badges']> = []

  for (const p of providers) {
    const getProviderMetadata = p.getProviderMetadata
    if (typeof getProviderMetadata !== 'function') continue
    const metadata = await fetchMetadata(() => getProviderMetadata({ providerId: provider.id, provider }))
    if (!metadata) continue
    mergeCommonMetadata(merged, badges, metadata)
  }

  if (badges.length > 0) merged.badges = badges
  if (Object.keys(merged).length === 0) return provider
  return { ...provider, pluginMetadata: merged }
}

export async function enrichProvidersWithPluginMetadata(providersToEnrich: Provider[]): Promise<Provider[]> {
  if (providers.length === 0) return providersToEnrich
  return Promise.all(
    providersToEnrich.map(async (provider) => {
      const enrichedProvider = await enrichProviderWithPluginMetadata(provider)
      return {
        ...enrichedProvider,
        models: await Promise.all(provider.models.map((model) => enrichModelWithPluginMetadata(provider.id, model))),
      }
    }),
  )
}
