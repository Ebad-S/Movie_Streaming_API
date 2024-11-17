/**
 * Movie API Server
 * Provides endpoints for movie search, data retrieval, and poster management
 * Combines data from OMDB and Streaming Availability APIs
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Import services and error classes
const { 
    searchMovieByTitle, 
    getMovieDataById,
    getMoviePoster,
    getOMDBData,
    ValidationError,
    NotFoundError,
    APIError
} = require('./movieService');

// Server Configuration
const PORT = process.env.PORT || 3000;
const POSTERS_DIR = path.join(__dirname, 'posters');

// Ensure posters directory exists for local storage
if (!fs.existsSync(POSTERS_DIR)) {
    fs.mkdirSync(POSTERS_DIR);
}

/**
 * Handles multipart form-data file uploads
 * Specifically designed for poster image uploads
 * @param {http.IncomingMessage} req - The HTTP request
 * @returns {Promise<Buffer>} The uploaded file data
 * @throws {Error} If file upload fails or invalid format
 */
const handleFileUpload = (req) => {
    return new Promise((resolve, reject) => {
        let data = [];
        let fileData = null;
        
        // Check content type
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            reject(new Error('Invalid content type. Must be multipart/form-data'));
            return;
        }
        
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
            reject(new Error('No boundary found in content type'));
            return;
        }

        req.on('data', chunk => {
            data.push(chunk);
        });
        
        req.on('error', (error) => {
            reject(new Error(`Upload error: ${error.message}`));
        });
        
        req.on('end', () => {
            try {
                // Combine chunks into a single buffer
                const buffer = Buffer.concat(data);
                const bodyString = buffer.toString();
                
                // Parse multipart form data
                const parts = bodyString.split(`--${boundary}`);
                const imagePart = parts.find(part => 
                    part.includes('Content-Type: image/') || 
                    part.includes('Content-Type: application/octet-stream')
                );
                
                if (!imagePart) {
                    reject(new Error('No image file found in request'));
                    return;
                }

                // Find the start and end of the actual image data
                const imageDataStart = buffer.indexOf('\r\n\r\n', buffer.indexOf('Content-Type: image/')) + 4;
                const imageDataEnd = buffer.indexOf(`\r\n--${boundary}`, imageDataStart);
                
                if (imageDataStart === -1 || imageDataEnd === -1) {
                    reject(new Error('Could not locate image data in request'));
                    return;
                }

                // Extract the actual image data as a Buffer
                fileData = buffer.slice(imageDataStart, imageDataEnd);
                
                if (!fileData || fileData.length === 0) {
                    reject(new Error('No image data found'));
                    return;
                }

                resolve(fileData);
            } catch (error) {
                reject(new Error(`Failed to parse upload: ${error.message}`));
            }
        });
    });
};

/**
 * Main server implementation
 * Handles all endpoints and their respective operations
 * Includes error handling and response formatting
 */
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Security Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");

    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    try {
        // Movie Search Endpoint
        if (pathname.startsWith('/movies/search/')) {
            const title = decodeURIComponent(pathname.split('/movies/search/')[1]);
            const data = await searchMovieByTitle(title);
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            });
            res.end(JSON.stringify(data));
        }
        
        // Movie Data Endpoint
        else if (pathname.startsWith('/movies/data/')) {
            const imdbId = pathname.split('/movies/data/')[1];
            const data = await getMovieDataById(imdbId);
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            });
            res.end(JSON.stringify(data));
        }
        
        // Poster Upload Endpoint
        else if (pathname.startsWith('/posters/add/') && req.method === 'POST') {
            const imdbId = pathname.split('/posters/add/')[1];
            
            // Verify content type is image/jpeg
            const contentType = req.headers['content-type'] || '';
            if (!contentType.includes('image/jpeg') && !contentType.includes('multipart/form-data')) {
                throw new ValidationError('Only JPG images are supported');
            }

            try {
                await getOMDBData(imdbId); // Verify movie exists
                const imageData = await handleFileUpload(req);
                const posterPath = path.join(POSTERS_DIR, `${imdbId}.jpg`);
                
                fs.writeFileSync(posterPath, imageData);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true,
                    message: 'Poster uploaded successfully',
                    path: `/posters/${imdbId}`
                }));
            } catch (error) {
                throw new ValidationError(error.message);
            }
        }
        
        // Poster Retrieval Endpoint
        else if (pathname.startsWith('/posters/') && !pathname.includes('add')) {
            const imdbId = pathname.split('/posters/')[1];
            console.log(`Getting poster for movie: ${imdbId}`);
            
            const posterPath = path.join(POSTERS_DIR, `${imdbId}.jpg`);
            
            // Check if poster exists locally (for manually uploaded posters)
            if (fs.existsSync(posterPath)) {
                console.log('Serving locally stored poster');
                const poster = fs.readFileSync(posterPath);
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                res.end(poster);
            } else {
                console.log('Fetching poster from API');
                const posterData = await getMoviePoster(imdbId);
                
                // Removed the local storage of API-fetched posters
                // Only serving the fetched poster directly
                
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                res.end(posterData);
            }
        }
        
        // 404 Handler
        else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Endpoint not found' }));
        }
    } catch (error) {
        // Error Handler
        console.error('Error:', error);
        
        const statusCode = error.status || 500;
        const errorResponse = {
            error: true,
            message: error.message
        };

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse));
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Posters directory: ${POSTERS_DIR}`);
}); 