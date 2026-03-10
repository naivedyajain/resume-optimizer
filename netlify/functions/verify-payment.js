// Verify Payment Status
// Location: netlify/functions/verify-payment.js

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const { email } = JSON.parse(event.body);

        if (!email) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email required' }) };
        }

        // TODO: Check your database for payment record
        // 
        // Example with Supabase:
        // const { createClient } = require('@supabase/supabase-js');
        // const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        // const { data, error } = await supabase
        //     .from('payments')
        //     .select('*')
        //     .eq('email', email)
        //     .eq('status', 'paid')
        //     .single();
        // 
        // if (data) {
        //     return { statusCode: 200, headers, body: JSON.stringify({ paid: true, paymentId: data.paymentId }) };
        // }

        // For now, return false (implement database check above)
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ paid: false })
        };

    } catch (error) {
        console.error('Verification error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
