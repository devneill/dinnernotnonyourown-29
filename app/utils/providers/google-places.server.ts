import { invariant } from '@epic-web/invariant'

interface NearbySearchParams {
  lat: number
  lng: number
  radius: number
}

interface NearbySearchResponse {
  results: Array<{
    place_id: string
    name: string
    price_level?: number
    rating?: number
    geometry: {
      location: {
        lat: number
        lng: number
      }
    }
    vicinity: string
  }>
  status: string
}

interface PlaceDetailsResponse {
  result: {
    photos?: Array<{
      photo_reference: string
    }>
    url?: string
  }
  status: string
}

interface Restaurant {
  id: string
  name: string
  priceLevel?: number
  rating?: number
  lat: number
  lng: number
  photoRef?: string
  mapsUrl?: string
}

export async function getNearbyRestaurants({
  lat,
  lng,
  radius,
}: NearbySearchParams): Promise<Restaurant[]> {
  invariant(process.env.GOOGLE_PLACES_API_KEY, 'GOOGLE_PLACES_API_KEY is required')
  
  // Make the initial Nearby Search request
  const nearbySearchUrl = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json')
  nearbySearchUrl.searchParams.append('location', `${lat},${lng}`)
  nearbySearchUrl.searchParams.append('radius', radius.toString())
  nearbySearchUrl.searchParams.append('type', 'restaurant')
  nearbySearchUrl.searchParams.append('key', process.env.GOOGLE_PLACES_API_KEY)
  
  const nearbySearchResponse = await fetch(nearbySearchUrl.toString())
  const nearbySearchData = await nearbySearchResponse.json() as NearbySearchResponse
  
  if (nearbySearchData.status !== 'OK' && nearbySearchData.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places API error: ${nearbySearchData.status}`)
  }
  
  if (nearbySearchData.status === 'ZERO_RESULTS' || !nearbySearchData.results.length) {
    return []
  }
  
  // For each restaurant, get additional details
  const restaurantsWithDetails = await Promise.all(
    nearbySearchData.results.map(async (place) => {
      const placeDetailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json')
      placeDetailsUrl.searchParams.append('place_id', place.place_id)
      placeDetailsUrl.searchParams.append('fields', 'photos,url')
      placeDetailsUrl.searchParams.append('key', process.env.GOOGLE_PLACES_API_KEY)
      
      const placeDetailsResponse = await fetch(placeDetailsUrl.toString())
      const placeDetailsData = await placeDetailsResponse.json() as PlaceDetailsResponse
      
      if (placeDetailsData.status !== 'OK') {
        console.error(`Error fetching details for place ${place.place_id}: ${placeDetailsData.status}`)
        // Return basic restaurant info without details
        return {
          id: place.place_id,
          name: place.name,
          priceLevel: place.price_level,
          rating: place.rating,
          lat: place.geometry.location.lat,
          lng: place.geometry.location.lng,
        }
      }
      
      // Transform data to match our database schema
      return {
        id: place.place_id,
        name: place.name,
        priceLevel: place.price_level,
        rating: place.rating,
        lat: place.geometry.location.lat,
        lng: place.geometry.location.lng,
        photoRef: placeDetailsData.result.photos?.[0]?.photo_reference,
        mapsUrl: placeDetailsData.result.url,
      }
    })
  )
  
  return restaurantsWithDetails
} 