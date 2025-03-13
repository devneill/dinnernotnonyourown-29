import { type User } from '@prisma/client'
import { cachified } from './cache.server'
import { lruCache } from './cache.server'
import { prisma } from './db.server'
import { getNearbyRestaurants } from './providers/google-places.server'

// Cache TTLs in milliseconds
const GOOGLE_PLACES_CACHE_TTL = 1000 * 60 * 60 * 24 // 24 hours
const RESTAURANT_CACHE_TTL = 1000 * 60 * 60 * 24 // 24 hours

// Types
export interface RestaurantWithDetails {
  id: string
  name: string
  priceLevel?: number | null
  rating?: number | null
  lat: number
  lng: number
  photoRef?: string | null
  mapsUrl?: string | null
  distance: number // in miles
  attendeeCount: number
  isUserAttending: boolean
}

// Helper functions
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  // Haversine formula to calculate distance between two points on Earth
  const R = 3958.8 // Earth's radius in miles
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const distance = R * c
  return parseFloat(distance.toFixed(1)) // Round to 1 decimal place
}

function toRad(degrees: number): number {
  return degrees * (Math.PI / 180)
}

// Restaurant Service Functions
export async function getAllRestaurantDetails(
  userLat: number,
  userLng: number,
  radius: number,
  userId?: string
): Promise<RestaurantWithDetails[]> {
  // Get restaurants from Google Places API with caching
  const restaurants = await cachified({
    key: `google-places-restaurants-${userLat}-${userLng}-${radius}`,
    cache: lruCache,
    ttl: GOOGLE_PLACES_CACHE_TTL,
    getFreshValue: async () => {
      const places = await getNearbyRestaurants({
        lat: userLat,
        lng: userLng,
        radius,
      })
      
      // Upsert restaurants to database
      await Promise.all(
        places.map(async (place) => {
          await prisma.restaurant.upsert({
            where: { id: place.id },
            update: {
              name: place.name,
              priceLevel: place.priceLevel,
              rating: place.rating,
              lat: place.lat,
              lng: place.lng,
              photoRef: place.photoRef,
              mapsUrl: place.mapsUrl,
              updatedAt: new Date(),
            },
            create: {
              id: place.id,
              name: place.name,
              priceLevel: place.priceLevel,
              rating: place.rating,
              lat: place.lat,
              lng: place.lng,
              photoRef: place.photoRef,
              mapsUrl: place.mapsUrl,
            },
          })
        })
      )
      
      return places
    },
  })
  
  // Get all restaurants from database with caching
  const dbRestaurants = await cachified({
    key: 'all-restaurants',
    cache: lruCache,
    ttl: RESTAURANT_CACHE_TTL,
    getFreshValue: async () => {
      return prisma.restaurant.findMany()
    },
  })
  
  // Get all dinner groups with attendee counts (not cached - must be real-time)
  const dinnerGroups = await prisma.dinnerGroup.findMany({
    include: {
      _count: {
        select: {
          attendees: true,
        },
      },
    },
  })
  
  // Get the dinner group the user is attending (if any)
  let userAttendingRestaurantId: string | null = null
  if (userId) {
    const userAttendee = await prisma.attendee.findUnique({
      where: { userId },
      include: {
        dinnerGroup: true,
      },
    })
    
    if (userAttendee) {
      userAttendingRestaurantId = userAttendee.dinnerGroup.restaurantId
    }
  }
  
  // Combine data and calculate distances
  const restaurantsWithDetails: RestaurantWithDetails[] = dbRestaurants.map((restaurant) => {
    const dinnerGroup = dinnerGroups.find(
      (group) => group.restaurantId === restaurant.id
    )
    
    return {
      id: restaurant.id,
      name: restaurant.name,
      priceLevel: restaurant.priceLevel,
      rating: restaurant.rating,
      lat: restaurant.lat,
      lng: restaurant.lng,
      photoRef: restaurant.photoRef,
      mapsUrl: restaurant.mapsUrl,
      distance: calculateDistance(userLat, userLng, restaurant.lat, restaurant.lng),
      attendeeCount: dinnerGroup?._count.attendees ?? 0,
      isUserAttending: userAttendingRestaurantId === restaurant.id,
    }
  })
  
  return restaurantsWithDetails
}

export async function joinDinnerGroup(userId: User['id'], restaurantId: string) {
  // First, check if the user is already in a dinner group
  const existingAttendee = await prisma.attendee.findUnique({
    where: { userId },
    include: { dinnerGroup: true },
  })
  
  // If the user is already in this dinner group, do nothing
  if (existingAttendee && existingAttendee.dinnerGroup.restaurantId === restaurantId) {
    return
  }
  
  // If the user is in a different dinner group, remove them from it
  if (existingAttendee) {
    await prisma.attendee.delete({
      where: { id: existingAttendee.id },
    })
    
    // If this was the last attendee, delete the dinner group
    const remainingAttendees = await prisma.attendee.count({
      where: { dinnerGroupId: existingAttendee.dinnerGroupId },
    })
    
    if (remainingAttendees === 0) {
      await prisma.dinnerGroup.delete({
        where: { id: existingAttendee.dinnerGroupId },
      })
    }
  }
  
  // Get or create a dinner group for the restaurant
  let dinnerGroup = await prisma.dinnerGroup.findUnique({
    where: { restaurantId },
  })
  
  if (!dinnerGroup) {
    dinnerGroup = await prisma.dinnerGroup.create({
      data: {
        restaurantId,
      },
    })
  }
  
  // Add the user to the dinner group
  await prisma.attendee.create({
    data: {
      userId,
      dinnerGroupId: dinnerGroup.id,
    },
  })
  
  // Invalidate the cache for this restaurant's attendance
  lruCache.delete('all-restaurants')
}

export async function leaveDinnerGroup(userId: User['id']) {
  // Find the user's current dinner group
  const attendee = await prisma.attendee.findUnique({
    where: { userId },
    include: { dinnerGroup: true },
  })
  
  if (!attendee) {
    return
  }
  
  // Remove the user from the dinner group
  await prisma.attendee.delete({
    where: { id: attendee.id },
  })
  
  // If this was the last attendee, delete the dinner group
  const remainingAttendees = await prisma.attendee.count({
    where: { dinnerGroupId: attendee.dinnerGroupId },
  })
  
  if (remainingAttendees === 0) {
    await prisma.dinnerGroup.delete({
      where: { id: attendee.dinnerGroupId },
    })
  }
  
  // Invalidate the cache for this restaurant's attendance
  lruCache.delete('all-restaurants')
} 