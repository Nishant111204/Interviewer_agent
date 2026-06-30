import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // face-api.js optionally requires 'canvas' for Node.js environments.
    // Mark it external so the client bundle doesn't try to import it.
    config.externals = [...(config.externals ?? []), { canvas: 'canvas' }]
    return config
  },
}

export default nextConfig
