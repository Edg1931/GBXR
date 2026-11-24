package com.gbxr.app.data

/**
 * The signed-in user's session token, sent to the backend as a Bearer JWT.
 *
 * Production: Supabase Auth (Google sign-in through Android Credential
 * Manager) via the supabase-kt client; return the current access token and
 * let the client refresh it. Every person signs in with their own account and
 * all their bots, memories and care data are tied to it.
 *
 * Development: the backend accepts "dev:<userId>" when DEV_AUTH=1.
 */
fun interface AuthSession {
    fun token(): String
}

class DevAuthSession(private val userId: String = "dev-user") : AuthSession {
    override fun token() = "dev:$userId"
}
