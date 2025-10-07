import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

// Helper to read the raw body for Stripe signature verification
function readRawBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    req.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { apiVersion: '2024-06-20' })
    const buf = await readRawBody(req)
    const sig = req.headers['stripe-signature'] as string
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET as string

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(buf, sig, webhookSecret)
    } catch (err: any) {
      return res.status(400).json({ ok: false, error: `Webhook signature failed: ${err.message}` })
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // Best-effort: get email
      const email =
        session.customer_details?.email ||
        (session.customer_email as string) ||
        ''

      // Try to discover tier from line_items.price.metadata.tier.
      // Stripe does NOT include line_items by default in webhooks: fetch full session with expand.
      let tier = ''
      try {
        const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items.data.price'] })
        const item = full?.line_items?.data?.[0]
        tier = item?.price?.metadata?.tier || (full.metadata as any)?.tier || ''
      } catch {
        // fallback to session metadata if present
        tier = ((session.metadata as any)?.tier || '') as string
      }

      if (email && tier) {
        const supabase = createClient(
          process.env.SUPABASE_URL as string,
          process.env.SUPABASE_SERVICE_ROLE_KEY as string
        )

        // Update existing profile by email (no-op if the user hasn't signed up yet)
        await supabase.from('profiles').update({ tier }).eq('email', email)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server error' })
  }
}
