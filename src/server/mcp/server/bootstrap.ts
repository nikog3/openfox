import { displayHost } from '../../utils/network.js'

export interface OpenFoxMcpBootstrapInput {
  host: string
  port: number
  authRequired: boolean
  sessionToken: string | null
}

export interface OpenFoxMcpBootstrapConfig {
  name: string
  transport: 'http'
  url: string
  headers?: Record<string, string>
}

export function buildOpenFoxMcpBootstrap(input: OpenFoxMcpBootstrapInput): OpenFoxMcpBootstrapConfig {
  if (input.authRequired && !input.sessionToken) {
    throw new Error('Session token could not be computed — cannot bootstrap an authenticated MCP endpoint')
  }

  const config: OpenFoxMcpBootstrapConfig = {
    name: 'openfox',
    transport: 'http',
    url: `http://${displayHost(input.host)}:${input.port}/mcp`,
  }
  if (input.authRequired && input.sessionToken) {
    config.headers = { Authorization: `Bearer ${input.sessionToken}` }
  }
  return config
}
