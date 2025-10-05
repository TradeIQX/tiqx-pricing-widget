import { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const config = { api: { bodyParser: false } }

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

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
      const email =
        (session.customer_details && session.customer_details.email) ||
        (session.customer_email as string) ||
        ''

      // Prefer price metadata.tier, fallback to session metadata.tier if you set it there
      let tier = ''
      if ((session as any)?.line_items?.data?.length) {
        tier = (session as any).line_items.data[0]?.price?.metadata?.tier || ''
      }
      if (!tier && session.metadata) {
        tier = (session.metadata as any).tier || ''
      }

      if (email && tier) {
        const supabase = createClient(
          process.env.SUPABASE_URL as string,
          process.env.SUPABASE_SERVICE_ROLE_KEY as string
        )
        await supabase.from('profiles').update({ tier }).eq('email', email)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server error' })
  }
}
