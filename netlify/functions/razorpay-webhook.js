// Razorpay Webhook Handler
// Location: netlify/functions/razorpay-webhook.js

const crypto = require('crypto');

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        
        if (!webhookSecret) {
            console.error('RAZORPAY_WEBHOOK_SECRET not configured');
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Webhook secret not configured' }) };
        }

        // Get the signature from headers
        const signature = event.headers['x-razorpay-signature'];
        
        if (!signature) {
            console.error('No signature in request');
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'No signature' }) };
        }

        // Verify signature
        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(event.body)
            .digest('hex');

        if (signature !== expectedSignature) {
            console.error('Invalid signature');
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
        }

        // Parse the webhook payload
        const payload = JSON.parse(event.body);
        const eventType = payload.event;

        console.log('Razorpay webhook received:', eventType);

        // Handle payment events
        if (eventType === 'payment_link.paid' || eventType === 'payment.captured') {
            const payment = payload.payload.payment?.entity || payload.payload.payment_link?.entity;
            
            const paymentData = {
                paymentId: payment?.id || payload.payload.payment_link?.entity?.id,
                amount: payment?.amount / 100, // Convert paise to rupees
                email: payment?.email || payment?.customer_details?.email,
                contact: payment?.contact || payment?.customer_details?.contact,
                status: 'paid',
                timestamp: new Date().toISOString()
            };

            console.log('Payment successful:', paymentData);

            // TODO: Store in database (Supabase, Firebase, etc.)
            // For now, we'll just log it
            // 
            // Example with Supabase:
            // const { createClient } = require('@supabase/supabase-js');
            // const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
            // await supabase.from('payments').insert(paymentData);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    success: true, 
                    message: 'Payment recorded',
                    paymentId: paymentData.paymentId
                })
            };
        }

        // Handle other events
        console.log('Unhandled event type:', eventType);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, message: 'Event received' })
        };

    } catch (error) {
        console.error('Webhook error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', message: error.message })
        };
    }
};
