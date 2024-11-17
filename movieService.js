/**
 * Movie Service Module
 * Handles API interactions with OMDB and Streaming Availability APIs
 * Combines data from both sources and manages poster operations
 */

const https = require('https');
require('dotenv').config();

// API Configuration
const STREAMING_API_KEY = process.env.STREAMING_API_KEY;
const STREAMING_API_HOST = process.env.STREAMING_API_HOST;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const REQUEST_TIMEOUT = 10000; // 10 seconds timeout for all requests

/**
 * Custom Error Classes for specific error handling
 */
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.status = 400; // Bad Request
    }
}

class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
        this.status = 404;
    }
}

class APIError extends Error {
    constructor(message, status = 500) {
        super(message);
        this.name = 'APIError';
        this.status = status;
    }
}

/**
 * Makes an HTTP request with improved error handling and logging
 * @param {Object} options - HTTP request options
 * @returns {Promise<Object>} Parsed response data
 * @throws {Error} Network or parsing errors
 */
const makeRequest = (options) => {
    return new Promise((resolve, reject) => {
        console.log(`Making request to: ${options.hostname}${options.path}`);
        
        const req = https.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    console.log(`Response status code: ${res.statusCode}`);
                    console.log(`Response headers:`, res.headers);
                    
                    const parsedData = JSON.parse(data);
                    
                    // Check if the API returned an error message
                    if (res.statusCode !== 200) {
                        console.error(`API Error Response:`, parsedData);
                        reject(new Error(`API Error (${res.statusCode}): ${parsedData.message || 'Unknown error'}`));
                        return;
                    }
                    
                    console.log('Successfully parsed response data');
                    resolve(parsedData);
                } catch (e) {
                    if (Buffer.isBuffer(data)) {
                        resolve(data); // For image responses
                    } else {
                        console.error('Failed to parse response:', e);
                        console.error('Raw response:', data);
                        reject(new Error(`Failed to parse response: ${e.message}`));
                    }
                }
            });
        });
        
        req.on('error', (error) => {
            console.error('Request error:', error);
            reject(new Error(`Network error: ${error.message}`));
        });

        // Handle timeout with increased duration
        req.setTimeout(REQUEST_TIMEOUT, () => {
            console.error(`Request timed out after ${REQUEST_TIMEOUT}ms`);
            req.destroy();
            reject(new Error('Request timeout'));
        });
        
        req.end();
    });
};

/**
 * Fetches movie data from OMDB API
 * @param {string} imdbId - IMDB ID of the movie
 * @returns {Promise<Object>} Movie data from OMDB
 * @throws {Error} If IMDB ID is invalid or API request fails
 */
const getOMDBData = async (imdbId) => {
    if (!imdbId) {
        throw new Error('IMDB ID is required');
    }

    try {
        const options = {
            hostname: 'www.omdbapi.com',
            path: `/?i=${imdbId}&apikey=${OMDB_API_KEY}`,
            method: 'GET'
        };
        
        const response = await makeRequest(options);
        
        if (response.Error) {
            throw new Error(`OMDB API Error: ${response.Error}`);
        }
        
        return response;
    } catch (error) {
        throw new Error(`Failed to get OMDB data: ${error.message}`);
    }
};

/**
 * Combines movie data from both OMDB and Streaming APIs
 * @param {string} imdbId - IMDB ID of the movie
 * @returns {Promise<Object>} Combined movie data
 * @throws {ValidationError} If IMDB ID is invalid
 * @throws {APIError} If API requests fail
 */
const getMovieDataById = async (imdbId) => {
    if (!imdbId || imdbId.trim() === '') {
        throw new ValidationError('You must supply an imdbID!');
    }

    if (!imdbId.startsWith('tt')) {
        throw new ValidationError('Invalid IMDb ID format. Must start with "tt"');
    }

    try {
        const [streamingData, omdbData] = await Promise.all([
            getStreamingData(imdbId),
            getOMDBData(imdbId)
        ]);

        if (omdbData.Response === 'False') {
            throw new ValidationError(omdbData.Error || 'Incorrect IMDb ID.');
        }

        return {
            ...omdbData,
            streaming: {
                poster: streamingData.imageSet?.verticalPoster?.w720,
                rating: streamingData.rating, // Added rating
                options: streamingData.streamingOptions
            }
        };
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }
        if (error.message.includes('not subscribed')) {
            throw new APIError('API subscription error', 403);
        }
        throw new APIError('The remote detail server returned an invalid response');
    }
};

// Renamed original getMovieDataById to getStreamingData
const getStreamingData = async (imdbId) => {
    if (!imdbId) {
        throw new Error('IMDB ID is required');
    }

    if (!imdbId.startsWith('tt')) {
        throw new Error('Invalid IMDB ID format. Must start with "tt"');
    }

    try {
        const options = {
            hostname: STREAMING_API_HOST,
            path: `/shows/${imdbId}?country=us`,
            method: 'GET',
            headers: {
                'X-RapidAPI-Key': STREAMING_API_KEY,
                'X-RapidAPI-Host': STREAMING_API_HOST,
                'Content-Type': 'application/json'
            }
        };
        
        return await makeRequest(options);
    } catch (error) {
        throw new Error(`Failed to get streaming data: ${error.message}`);
    }
};

// Updated search function to combine results
const searchMovieByTitle = async (title) => {
    if (!title || title.trim() === '') {
        throw new ValidationError('You must supply a title!');
    }

    try {
        // Search in Streaming API
        const streamingResults = await searchStreamingByTitle(title);
        
        // Get OMDB data for each result
        const combinedResults = await Promise.all(
            streamingResults.map(async (movie) => {
                try {
                    const omdbData = await getOMDBData(movie.imdbId);
                    return {
                        ...omdbData,
                        streaming: {
                            poster: movie.imageSet?.verticalPoster?.w720,
                            rating: movie.rating, // Added rating from streaming API
                            options: movie.streamingOptions
                        }
                    };
                } catch (error) {
                    console.error(`Failed to get OMDB data for ${movie.imdbId}:`, error);
                    return null;
                }
            })
        );

        const validResults = combinedResults.filter(result => result !== null);
        
        if (validResults.length === 0) {
            throw new NotFoundError(`No movies found with title: ${title}`);
        }
        
        return validResults;
    } catch (error) {
        if (error instanceof ValidationError || error instanceof NotFoundError) {
            throw error;
        }
        throw new APIError('The remote detail server returned an invalid response');
    }
};

// Renamed original searchMovieByTitle to searchStreamingByTitle
const searchStreamingByTitle = async (title) => {
    if (!title) {
        throw new Error('Movie title is required');
    }

    try {
        console.log(`Searching for movie title: ${title}`);
        const options = {
            hostname: STREAMING_API_HOST,
            path: `/shows/search/title?title=${encodeURIComponent(title)}&country=us&show_type=movie&output_language=en`,
            method: 'GET',
            headers: {
                'X-RapidAPI-Key': STREAMING_API_KEY,
                'X-RapidAPI-Host': STREAMING_API_HOST,
                'Content-Type': 'application/json'
            }
        };
        
        console.log('Request options:', {
            url: `https://${options.hostname}${options.path}`,
            method: options.method,
            headers: options.headers
        });
        
        const response = await makeRequest(options);
        
        if (!response || !response.length) {
            console.log('No movies found in response');
            throw new Error(`No movies found with title: ${title}`);
        }
        
        console.log(`Found ${response.length} movies`);
        return response;
    } catch (error) {
        console.error('Search error:', error);
        throw new Error(`Failed to search movies: ${error.message}`);
    }
};

const getMoviePoster = async (imdbId) => {
    if (!imdbId || imdbId.trim() === '') {
        throw new ValidationError('You must supply an imdbID!');
    }

    try {
        // Get data from both APIs
        const [streamingData, omdbData] = await Promise.all([
            getStreamingData(imdbId),
            getOMDBData(imdbId)
        ]);
        
        // Check all possible poster sources in order of preference
        const posterUrl = streamingData.imageSet?.verticalPoster?.w720 || 
                         streamingData.imageSet?.verticalPoster?.w480 || 
                         streamingData.imageSet?.verticalPoster?.w360 || 
                         streamingData.imageSet?.horizontalPoster?.w720 ||
                         omdbData.Poster; // Fallback to OMDB poster
        
        if (!posterUrl) {
            throw new Error(`No poster available for movie with IMDB ID: ${imdbId}`);
        }
        
        console.log('Attempting to fetch poster from:', posterUrl);
        
        return new Promise((resolve, reject) => {
            const posterRequest = https.get(posterUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': posterUrl.includes('rapidapi') ? 
                        'https://streaming-availability.p.rapidapi.com/' : 
                        'http://www.omdbapi.com/'
                }
            }, (response) => {
                // Handle redirects
                if (response.statusCode === 301 || response.statusCode === 302) {
                    console.log('Following redirect to:', response.headers.location);
                    https.get(response.headers.location, (redirectResponse) => {
                        if (redirectResponse.statusCode !== 200) {
                            reject(new Error(`Failed to fetch poster after redirect: HTTP ${redirectResponse.statusCode}`));
                            return;
                        }
                        
                        const chunks = [];
                        redirectResponse.on('data', (chunk) => chunks.push(chunk));
                        redirectResponse.on('end', () => {
                            const posterData = Buffer.concat(chunks);
                            if (posterData.length === 0) {
                                reject(new Error('Received empty poster data'));
                                return;
                            }
                            resolve(posterData);
                        });
                    }).on('error', error => reject(new Error(`Redirect request failed: ${error.message}`)));
                    return;
                }

                if (response.statusCode !== 200) {
                    console.error('Poster fetch failed with status:', response.statusCode);
                    console.error('Response headers:', response.headers);
                    reject(new Error(`Failed to fetch poster: HTTP ${response.statusCode}`));
                    return;
                }

                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const posterData = Buffer.concat(chunks);
                    if (posterData.length === 0) {
                        reject(new Error('Received empty poster data'));
                        return;
                    }
                    resolve(posterData);
                });
                response.on('error', (error) => reject(new Error(`Poster download failed: ${error.message}`)));
            }).on('error', (error) => reject(new Error(`Poster request failed: ${error.message}`)));

            posterRequest.setTimeout(10000, () => {
                posterRequest.destroy();
                reject(new Error('Poster request timeout'));
            });
        });
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }
        throw new APIError('The image could not be found or could not be read');
    }
};

module.exports = {
    searchMovieByTitle,
    getMovieDataById,
    getMoviePoster,
    getOMDBData,
    ValidationError,
    NotFoundError,
    APIError
}; 