import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = searchParams.get('lat');
  const lng = searchParams.get('lng');
  const q   = searchParams.get('q');     // alternative: location name

  const location = q ? encodeURIComponent(q) : `${lat},${lng}`;
  if (!location || location === 'null,null') {
    return NextResponse.json({ error: 'Missing location' }, { status: 400 });
  }

  try {
    // wttr.in is completely free, no API key required
    const res = await fetch(`https://wttr.in/${location}?format=j1`, {
      headers: {
        'User-Agent': 'JarvisClient/1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return NextResponse.json({ error: `wttr.in HTTP ${res.status}` }, { status: 502 });
    const data = await res.json();

    // Flatten into a simpler shape for the UI
    const cc = data?.current_condition?.[0];
    if (!cc) return NextResponse.json({ error: 'No weather data' }, { status: 502 });

    return NextResponse.json({
      tempC: parseInt(cc.temp_C),
      tempF: parseInt(cc.temp_F),
      feelsLikeC: parseInt(cc.FeelsLikeC),
      feelsLikeF: parseInt(cc.FeelsLikeF),
      humidity: parseInt(cc.humidity),
      windMph: parseInt(cc.windspeedMiles),
      windDir: cc.winddir16Point,
      description: cc.weatherDesc?.[0]?.value ?? '',
      visibilityMiles: parseInt(cc.visibility),
      uvIndex: parseInt(cc.uvIndex),
      weatherCode: parseInt(cc.weatherCode),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
