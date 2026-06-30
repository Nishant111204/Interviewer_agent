'use client'

import { createContext, useContext } from 'react'

export interface AuthContextValue {
  accessToken: string
}

export const AuthContext = createContext<AuthContextValue>({ accessToken: '' })

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
