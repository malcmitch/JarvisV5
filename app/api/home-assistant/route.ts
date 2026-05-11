import { NextRequest, NextResponse } from 'next/server';

// Proxy all Home Assistant REST API requests server-side to avoid CORS and
// to keep the long-lived access token out of client-side network logs.

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const haUrl  = (searchParams.get('url')  ?? '').replace(/\/$/, '');
  const token  = searchParams.get('token') ?? '';
  const path   = searchParams.get('path')  ?? '/api/states';

  if (!haUrl || !token) {
    return NextResponse.json({ error: 'url and token are required' }, { status: 400 });
  }

  try {
    const res = await fetch(`${haUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `HA returned ${res.status}: ${text}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: `Failed to reach Home Assistant: ${String(err)}` }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      url: string;
      token: string;
      domain: string;
      service: string;
      serviceData?: Record<string, unknown>;
    };

    const { url, token, domain, service, serviceData = {} } = body;

    if (!url || !token || !domain || !service) {
      return NextResponse.json({ error: 'url, token, domain, and service are required' }, { status: 400 });
    }

    const haUrl = url.replace(/\/$/, '');
    const res = await fetch(`${haUrl}/api/services/${domain}/${service}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(serviceData),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `HA returned ${res.status}: ${text}` }, { status: res.status });
    }

    const data = await res.json().catch(() => ({}));
    return NextResponse.json({ success: true, result: data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
