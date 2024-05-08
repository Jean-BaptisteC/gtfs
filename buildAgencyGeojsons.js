import { joinFeatureCollections, rejectNullValues } from './utils.js'
import toposort from 'toposort'

import {
  getCalendarDates,
  getCalendars,
  getRoutes,
  getStops,
  getStoptimes,
  getTrips,
} from 'gtfs'
import {
  computeFrequencyPerDay,
  computeIsNight,
  computeIsSchool,
} from './timetableAnalysis.js'

export const buildAgencyGeojsonsForRail = (agency_id, noGathering) => {
  console.time('get routes')
  const routes = getRoutes({ agency_id })
  console.timeLog('get routes')

  const stopsMap = {}

  const features = routes
    /*
    .filter(
      (route) =>
        route.route_id === 'FR:Line::D6BAEC78-815E-4C9A-BC66-2B9D2C00E41F:'
    )
	*/
    //what's that ? Filtering TGV lines ?
    //.filter(({ route_short_name }) => route_short_name.match(/^\d.+/g))
    .map((route) => {
      const trips = getTrips({ route_id: route.route_id })
      //console.log(trips.slice(0, 2), trips.length)

      const tripLineStrings = trips.map((trip) => {
        const { trip_id, service_id } = trip

        const calendarDates = getCalendarDates({ service_id })
        const calendars = getCalendars({ service_id })
        // trips stopTimes defines trips *per day*. Then calendars define which days the trip happens. Frequency needs both. We're defining a frequency per day. Each agency can be defined on arbitrary periods, hence the need to divide

        const perDay = computeFrequencyPerDay(calendars, calendarDates)

        const stopTimes = getStoptimes({ trip_id })

        const isSchool = computeIsSchool(calendars, calendarDates, stopTimes)
        const isNight = computeIsNight(stopTimes)

        const stops = stopTimes.map(({ stop_id }) => {
          const stops = getStops({ stop_id })
          if (stops.length > 1)
            throw new Error('One stoptime should correspond to only one stop')

          const stop = stops[0]

          // This strategy is good to simplify lines, handle at the same time both directions, and gather lines on a map...
          // ... but it fails when trying to find the exact bus stop and seeing precise shapes when the user zooms
          if (!stopsMap[stop.stop_name])
            stopsMap[stop.stop_name] = {
              ...stop,
              perDay,
              ids: new Set([stop.stop_id]),
            }
          else {
            const oldStop = stopsMap[stop.stop_name]
            oldStop.perDay = oldStop.perDay + perDay
            oldStop.ids.add(stop.stop_id)
          }

          return stop
        })
        const sncfTrainType = stops.reduce((memo, stop) => {
          const key = 'StopPoint:OCE'
          const probe = stop.stop_id.startsWith(key)

          if (!probe) return memo || null
          const type = stop.stop_id.replace(key, '').split('-')[0]
          if (
            ![
              'TGV INOUI',
              'OUIGO',
              'Lyria',
              'Train',
              'Train TER',
              'Car TER',
              'Car',
              'Navette',
              'INTERCITES',
              'INTERCITES de nuit',
              'TramTrain',
              'ICE',
            ].includes(type)
          ) {
            console.log(stop.stop_id)
            throw new Error('Unknown SNCF train stop type ' + type)
          }
          return memo || type
        }, null)

        const coordinates = stops.map(({ stop_lon, stop_lat }) => [
            stop_lon,
            stop_lat,
          ]),
          stopList = stops.map(({ stop_name }) => stop_name)

        const dates = null //getCalendarDates({ service_id: trip.service_id })

        const properties = rejectNullValues({
          ...route,
          ...trip,
          dates,
          stopList,
          sncfTrainType,
          perDay,
          isNight,
          isSchool,
        })

        const feature = {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates },
          properties,
        }
        //beautiful, but not really useful I'm afraid...
        //return bezierSpline(feature)
        return feature
      })

      if (!tripLineStrings.length) return null

      const perDay = tripLineStrings.reduce(
        (memo, next) => memo + next.properties.perDay,
        0
      )
      const isNight =
        tripLineStrings.filter(
          ({ properties: { isNight } }) => isNight === true
        ).length >
        0.8 * tripLineStrings.length

      const isSchool =
        tripLineStrings.filter(
          ({ properties: { isSchool } }) => isSchool === true
        ).length ===
        1 * tripLineStrings.length

      const mostStops = tripLineStrings.sort(
        (a, b) => b.geometry.coordinates.length - a.geometry.coordinates.length
      )[0]

      const mostStopsWithCount = {
        ...mostStops,
        properties: { ...mostStops.properties, perDay, isNight, isSchool },
      }

      const mostStopsLength = mostStops.geometry.coordinates.length,
        stopsLength = Object.keys(stopsMap).length
      if (false)
        console.log(
          'Number of stops ',
          stopsLength,
          ' and number of stops for the trip with most stops ',
          mostStopsLength
        )
      if (mostStopsLength === stopsLength)
        return {
          type: 'Feature',
          geometry: mostStops.geometry,
          properties: mostStopsWithCount.properties,
        }
      else {
        return mostStopsWithCount
        /* Old comment : Very simple and potentially erroneous way to avoid straight lines that don't show stops where the trains don't stop.
         * Not effective : lots of straight lines persist through routes that cross France*/
        /* New comment : the line with the most stops does not necessarily include all stops, so we still need the order.
         * We need toposort as recommended by https://github.com/BlinkTagInc/gtfs-to-geojson/issues/24#issuecomment-1974415400
         * */
        const graph = features.map((feature) => feature.properties.stopList)
        try {
          const fullStopList = toposort(graph)

          return {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: fullStopList.map((name) => {
                const stop = stopsMap[name]
                return [stop.stop_lon, stop.stop_lat]
              }),
            },
            properties: { fullStopList, ...route },
          }
        } catch (e) {
          console.log(e)
          return mostStops
        }
      }

      return {
        type: 'FeatureCollection',
        features,
        //bezierSpline(mostStops),
        //mostStops,
      }
    })
    .filter(Boolean)

  const stops = Object.values(stopsMap).map((stop) =>
    /*
		   {
  stop_id: 'StopPoint:OCEOUIGO-87681825',
  stop_code: null,
  stop_name: 'Villeneuve-Saint-Georges',
  tts_stop_name: null,
  stop_desc: null,
  stop_lat: 48.731182,
  stop_lon: 2.446434,
  zone_id: null,
  stop_url: null,
  location_type: null,
  parent_station: 'StopArea:OCE87681825',
  stop_timezone: null,
  wheelchair_boarding: null,
  level_id: null,
  platform_code: null
}
*/

    ({
      type: 'Feature',
      properties: {
        ids: [...stop.ids],
        name: stop.stop_name,
        perDay: stop.perDay,
        /*
      count: segmentEntries
        .filter(([k]) => k.includes(id))
        .reduce((memo, next) => memo + next[1], 0),
		*/
      },
      geometry: {
        type: 'Point',
        coordinates: [stop.stop_lon, stop.stop_lat],
      },
    })
  )

  // Now we've got a stopList for each route, good but lots of routes share a same path, the map is difficult to read since direct routes draw far from their real path
  // So we'll group them, and show the routes on click. Also, points will vary in size to denote important stations where the train *stops* a lot, instead of passing without stopping
  // Unfortunately, it's impossible. If one route is C -> A -> B with a real rail, another is C -> B with a real rail too, we can't know if the second one really has a real rail only based on its stops !
  // Wait ! In theory, this situation happens. But in practice ? Rennes->Nantes could be misplaced on Rennes->Angers-Nantes, but there's Rennes->Redon->Nantes, so we just need to pick the shortest. There's also Rennes->Chateaubriand->Nantes that is even shorter, but no route. Most direct routes that we want to simplify won't have a very long alternative with a route.
  // So in practice, this strategy might work and be the best compromis.
  //
  // Thing is, we don't have shapes, and my attempt to use Pfaedle to create shapes failed (france.osm too big on my robust computer). + not sure it could.
  // The map of rail lines is not really pertinent. E.g. there can be a rail line but no train 10 month of the year. Or their can be no rail line but a very frequent bus, more in the future with electric buses.
  // The most important is the GTFS file, but I' haven't found a way yet to display it

  if (noGathering)
    return {
      type: 'FeatureCollection',
      features: [...features, ...stops],
    }

  console.log('built ', features.length, ' features before gathering')

  const gathered = features
    .map((feature, featureIndex) => {
      const stopList = feature.properties.stopList

      const couples = stopList
        .slice(0, -1)
        .map((el, i) => [stopList[i], stopList[i + 1]])

      const extendedCouples = couples.map((couple) => {
        const coupleExtension = features
          .map((otherFeature, otherFeatureIndex) => {
            const otherList = otherFeature.properties.stopList

            const indexA = otherList.indexOf(couple[0])
            const indexB = otherList.indexOf(couple[1])
            const diff = Math.abs(indexA - indexB)
            const notFound =
              otherFeatureIndex === featureIndex ||
              indexA === -1 ||
              indexB === -1 ||
              diff === 1
            if (notFound) return false
            else {
              if (indexB > indexA) return otherList.slice(indexA, indexB + 1)
              else return [...otherList.slice(indexB, indexA + 1)].reverse()
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)[0]

        if (coupleExtension) return coupleExtension
        else return couple
      })
      if (extendedCouples.find((list) => list.length > 2))
        return {
          type: 'Feature',
          properties: { ...feature.properties, extended: true },
          geometry: {
            coordinates: extendedCouples.flat().map((stopName) => {
              const stop = stopsMap[stopName]
              return [stop.stop_lon, stop.stop_lat]
            }),
            type: 'LineString',
          },
        }
      else return feature
    })
    .filter(Boolean)

  return {
    type: 'FeatureCollection',
    features: [...gathered, ...stops],
  }
}

/* This is our first algorithm. It creates a map of segments collected from trips, and attaches a tripIds property, and counts their importance by their frequency */
export const buildAgencyGeojsons = (agency_id) => {
  const routes = getRoutes({ agency_id })

  const segmentMap = new Map()
  const segmentCoordinatesMap = new Map()
  const featureCollections = routes.forEach((route) => {
    const trips = getTrips({ route_id: route.route_id })

    trips.forEach((trip) => {
      const { trip_id } = trip
      const stopTimes = getStoptimes({ trip_id })

      const points = stopTimes.map(({ stop_id }) => {
        const stops = getStops({ stop_id })
        if (stops.length > 1)
          throw new Error('One stoptime should correspond to only one stop')

        const { stop_lat, stop_lon, stop_name } = stops[0]
        const coordinates = [stop_lon, stop_lat]
        if (!segmentCoordinatesMap.has(stop_id))
          segmentCoordinatesMap.set(stop_id, coordinates)
        return {
          coordinates,
          stop: { id: stop_id, name: stop_name },
        }
      })

      const dates = getCalendarDates({ service_id: trip.service_id })

      const segments = points
        .map(
          (point, index) =>
            index > 0 && [
              point.stop.id + ' -> ' + points[index - 1].stop.id,
              { count: dates.length, tripId: trip_id },
            ]
        )
        .filter(Boolean)

      segments.forEach(([segmentKey, trip]) => {
        const current = segmentMap.get(segmentKey) || {
          count: 0,
          tripIds: [],
        }

        const newTrip = {
          count: current.count + trip.count,
          tripIds: [...current.tripIds, trip.tripId],
        }
        segmentMap.set(segmentKey, newTrip)
      })

      /*
        const properties = rejectNullValues({ ...route, ...trip, dates })

        const feature = {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates },
          properties,
        }
		*/
      //beautiful, but not really useful I'm afraid...
      //return bezierSpline(feature)
      //return feature
    })
  }, {})

  const segmentEntries = [...segmentMap.entries()]

  const lines = segmentEntries.map(([segmentId, properties]) => {
    const [a, b] = segmentId.split(' -> ')
    const pointA = segmentCoordinatesMap.get(a),
      pointB = segmentCoordinatesMap.get(b)
    return {
      geometry: { type: 'LineString', coordinates: [pointA, pointB] },
      properties,
      type: 'Feature',
    }
  })

  const points = [...segmentCoordinatesMap.entries()].map(([id, value]) => ({
    type: 'Feature',
    properties: {
      stopId: id,
      count: segmentEntries
        .filter(([k]) => k.includes(id))
        .reduce((memo, next) => memo + next[1], 0),
    },
    geometry: {
      type: 'Point',
      coordinates: value,
    },
  }))

  return { type: 'FeatureCollection', features: [...lines, ...points] }
  return joinFeatureCollections(featureCollections)
}
