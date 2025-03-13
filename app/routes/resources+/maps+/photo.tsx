import { invariant } from '@epic-web/invariant'
import { type LoaderFunctionArgs } from 'react-router'

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const photoRef = url.searchParams.get('photoRef')
  
  invariant(photoRef, 'Photo reference is required')
  invariant(process.env.GOOGLE_PLACES_API_KEY, 'GOOGLE_PLACES_API_KEY is required')
  
  const photoUrl = new URL('https://maps.googleapis.com/maps/api/place/photo')
  photoUrl.searchParams.append('maxwidth', '400')
  photoUrl.searchParams.append('photoreference', photoRef)
  photoUrl.searchParams.append('key', process.env.GOOGLE_PLACES_API_KEY)
  
  const response = await fetch(photoUrl.toString())
  
  if (!response.ok) {
    throw new Response('Failed to fetch photo', { status: response.status })
  }
  
  const headers = new Headers()
  headers.set('Cache-Control', 'public, max-age=86400') // Cache for 24 hours
  
  // Forward the content type from the Google API
  const contentType = response.headers.get('Content-Type')
  if (contentType) {
    headers.set('Content-Type', contentType)
  }
  
  return new Response(response.body, {
    status: 200,
    headers,
  })
} 