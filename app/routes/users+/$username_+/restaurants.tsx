import { invariant } from '@epic-web/invariant'
import { type LoaderFunctionArgs, type ActionFunctionArgs, useLoaderData, useSearchParams, Link, useFetcher } from 'react-router'
import { z } from 'zod'
import { requireUserId } from '#app/utils/auth.server'
import { prisma } from '#app/utils/db.server'
import { getAllRestaurantDetails, joinDinnerGroup, leaveDinnerGroup, type RestaurantWithDetails } from '#app/utils/restaurants.server'
import { cn } from '#app/utils/misc'
import { StatusButton } from '#app/components/ui/status-button'
import { Button } from '#app/components/ui/button'
import { MapPin, Map, Star } from 'lucide-react'

// Hilton coordinates in Salt Lake City
const HILTON_LAT = 40.7596
const HILTON_LNG = -111.8867

// Conversion from miles to meters for Google Places API
const MILES_TO_METERS = 1609.34

// Zod schema for action validation
const ActionSchema = z.object({
  intent: z.enum(['join', 'leave']),
  restaurantId: z.string().optional(),
})

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  
  // Get URL search params for filtering
  const url = new URL(request.url)
  const distanceParam = url.searchParams.get('distance')
  const ratingParam = url.searchParams.get('rating')
  const priceParam = url.searchParams.get('price')
  
  // Convert distance to meters (default to 1 mile)
  const distanceInMiles = distanceParam ? parseInt(distanceParam, 10) : 1
  const radiusInMeters = distanceInMiles * MILES_TO_METERS
  
  // Get all restaurant details
  const allRestaurants = await getAllRestaurantDetails(
    HILTON_LAT,
    HILTON_LNG,
    radiusInMeters,
    userId,
  )
  
  // Split into two lists: with attendees and nearby
  const restaurantsWithAttendance = allRestaurants
    .filter(restaurant => restaurant.attendeeCount > 0)
    .sort((a, b) => b.attendeeCount - a.attendeeCount)
  
  // Apply filters to nearby restaurants
  let restaurantsNearby = allRestaurants.filter(
    restaurant => restaurant.attendeeCount === 0
  )
  
  // Apply distance filter
  if (distanceParam) {
    const maxDistance = parseInt(distanceParam, 10)
    restaurantsNearby = restaurantsNearby.filter(
      restaurant => restaurant.distance <= maxDistance
    )
  }
  
  // Apply rating filter
  if (ratingParam) {
    const minRating = parseInt(ratingParam, 10)
    restaurantsNearby = restaurantsNearby.filter(
      restaurant => (restaurant.rating ?? 0) >= minRating
    )
  }
  
  // Apply price filter
  if (priceParam) {
    const exactPrice = parseInt(priceParam, 10)
    restaurantsNearby = restaurantsNearby.filter(
      restaurant => restaurant.priceLevel === exactPrice
    )
  }
  
  // Sort by rating (desc) and distance (asc) as tiebreaker
  restaurantsNearby.sort((a, b) => {
    const ratingDiff = (b.rating ?? 0) - (a.rating ?? 0)
    if (ratingDiff !== 0) return ratingDiff
    return a.distance - b.distance
  })
  
  // Limit to top 15 results
  restaurantsNearby = restaurantsNearby.slice(0, 15)
  
  return {
    restaurantsWithAttendance,
    restaurantsNearby,
    filters: {
      distance: distanceParam,
      rating: ratingParam,
      price: priceParam,
    },
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request)
  const formData = await request.formData()
  
  // Validate form data
  const result = ActionSchema.safeParse(Object.fromEntries(formData))
  
  if (!result.success) {
    return { status: 'error', errors: result.error.flatten() }
  }
  
  const { intent, restaurantId } = result.data
  
  if (intent === 'join') {
    invariant(restaurantId, 'Restaurant ID is required for joining')
    await joinDinnerGroup(userId, restaurantId)
  } else if (intent === 'leave') {
    await leaveDinnerGroup(userId)
  }
  
  // Return empty object to trigger revalidation
  return {}
}

export default function RestaurantsPage() {
  const { restaurantsWithAttendance, restaurantsNearby, filters } = useLoaderData<typeof loader>()
  
  return (
    <div className="container py-8">
      <h1 className="text-3xl font-bold mb-8">Restaurants</h1>
      
      <div className="space-y-12">
        <DinnerPlansSection restaurants={restaurantsWithAttendance} />
        <RestaurantListSection 
          restaurants={restaurantsNearby} 
          filters={filters} 
        />
      </div>
    </div>
  )
}

function DinnerPlansSection({ restaurants }: { restaurants: RestaurantWithDetails[] }) {
  return (
    <section>
      <h2 className="text-2xl font-bold mb-4">Dinner Plans</h2>
      
      {restaurants.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {restaurants.map(restaurant => (
            <RestaurantCard key={restaurant.id} restaurant={restaurant} />
          ))}
        </div>
      ) : (
        <div className="border-2 border-dashed rounded-lg p-8 flex items-center justify-center h-64">
          <p className="text-lg text-gray-500">Everyone is having dinner on their own 🥲</p>
        </div>
      )}
    </section>
  )
}

function RestaurantListSection({ 
  restaurants, 
  filters 
}: { 
  restaurants: RestaurantWithDetails[], 
  filters: { distance: string | null, rating: string | null, price: string | null } 
}) {
  return (
    <section>
      <h2 className="text-2xl font-bold mb-4">Restaurants Nearby</h2>
      
      <Filters currentFilters={filters} />
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-6">
        {restaurants.map(restaurant => (
          <RestaurantCard key={restaurant.id} restaurant={restaurant} />
        ))}
        
        {restaurants.length === 0 && (
          <div className="col-span-full border-2 border-dashed rounded-lg p-8 flex items-center justify-center h-64">
            <p className="text-lg text-gray-500">No restaurants match your filters</p>
          </div>
        )}
      </div>
    </section>
  )
}

function Filters({ 
  currentFilters 
}: { 
  currentFilters: { distance: string | null, rating: string | null, price: string | null } 
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  
  const setFilter = (key: string, value: string | null) => {
    const newParams = new URLSearchParams(searchParams)
    
    if (value === null) {
      newParams.delete(key)
    } else {
      newParams.set(key, value)
    }
    
    setSearchParams(newParams, { preventScrollReset: true, replace: true })
  }
  
  const isActive = (key: string, value: string) => {
    return currentFilters[key as keyof typeof currentFilters] === value
  }
  
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Distance</h3>
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 5, 10].map(distance => (
            <Button
              key={distance}
              variant={isActive('distance', distance.toString()) ? 'default' : 'outline'}
              onClick={() => setFilter('distance', isActive('distance', distance.toString()) ? null : distance.toString())}
              className="w-full"
            >
              {distance} mi
            </Button>
          ))}
        </div>
      </div>
      
      <div>
        <h3 className="text-sm font-medium mb-2">Rating</h3>
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 4].map(rating => (
            <Button
              key={rating}
              variant={isActive('rating', rating.toString()) ? 'default' : 'outline'}
              onClick={() => setFilter('rating', isActive('rating', rating.toString()) ? null : rating.toString())}
              className="w-full"
            >
              {'⭐'.repeat(rating)}
            </Button>
          ))}
        </div>
      </div>
      
      <div>
        <h3 className="text-sm font-medium mb-2">Price</h3>
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 4].map(price => (
            <Button
              key={price}
              variant={isActive('price', price.toString()) ? 'default' : 'outline'}
              onClick={() => setFilter('price', isActive('price', price.toString()) ? null : price.toString())}
              className="w-full"
            >
              {'$'.repeat(price)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}

function RestaurantCard({ restaurant }: { restaurant: RestaurantWithDetails }) {
  const fetcher = useFetcher()
  const isJoining = fetcher.state === 'submitting' && fetcher.formData?.get('intent') === 'join'
  const isLeaving = fetcher.state === 'submitting' && fetcher.formData?.get('intent') === 'leave'
  
  return (
    <div className="border rounded-lg overflow-hidden flex flex-col">
      <div className="relative h-48">
        {restaurant.photoRef ? (
          <img 
            src={`/resources/maps/photo?photoRef=${restaurant.photoRef}`}
            alt={restaurant.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-400">No image available</span>
          </div>
        )}
        
        <div className="absolute top-2 right-2 flex flex-col gap-1">
          {restaurant.rating ? (
            <span className="bg-white px-2 py-1 rounded-md text-sm font-medium flex items-center">
              {restaurant.rating} <Star className="w-4 h-4 ml-1 text-yellow-400" />
            </span>
          ) : null}
          
          {restaurant.priceLevel ? (
            <span className="bg-white px-2 py-1 rounded-md text-sm font-medium">
              {'$'.repeat(restaurant.priceLevel)}
            </span>
          ) : null}
        </div>
      </div>
      
      <div className="p-4 flex-1 flex flex-col">
        <h3 className="font-bold text-lg mb-1">{restaurant.name}</h3>
        
        <div className="flex items-center text-sm text-gray-600 mb-2">
          <MapPin className="w-4 h-4 mr-1" />
          <span>{restaurant.distance} mi</span>
        </div>
        
        {restaurant.mapsUrl && (
          <a 
            href={restaurant.mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:underline flex items-center mb-2"
          >
            <Map className="w-4 h-4 mr-1" />
            Directions
          </a>
        )}
        
        <div className="mt-auto">
          <div className="text-sm mb-2">
            {restaurant.attendeeCount > 0 ? (
              <span>{restaurant.attendeeCount} attending</span>
            ) : (
              <span>&nbsp;</span>
            )}
          </div>
          
          <fetcher.Form method="post" className="mt-2">
            <input type="hidden" name="restaurantId" value={restaurant.id} />
            
            {restaurant.isUserAttending ? (
              <StatusButton
                type="submit"
                name="intent"
                value="leave"
                status={isLeaving ? 'pending' : 'idle'}
                className="w-full"
                variant="destructive"
              >
                {isLeaving ? 'Leaving...' : 'Leave'}
              </StatusButton>
            ) : (
              <StatusButton
                type="submit"
                name="intent"
                value="join"
                status={isJoining ? 'pending' : 'idle'}
                className="w-full"
              >
                {isJoining ? 'Joining...' : 'Join'}
              </StatusButton>
            )}
          </fetcher.Form>
        </div>
      </div>
    </div>
  )
} 