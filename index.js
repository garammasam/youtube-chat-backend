import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import { DOMParser } from 'xmldom';

dotenv.config();

// Initialize YouTube API with service account
const youtube = google.youtube('v3');
let auth;

if (process.env.NODE_ENV === 'production') {
  // In production, use the JSON credentials from environment variable
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ]
  });
} else {
  // In development, use the key file
  auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ]
  });
}

// Log environment information
console.log('Server starting with:', {
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  env: process.env.NODE_ENV || 'development'
});

// Verify YouTube Transcript package
try {
  console.log('YouTube Transcript package version:', require('youtube-transcript/package.json').version);
} catch (e) {
  console.warn('Could not determine YouTube Transcript package version');
}

const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173', 
    'http://127.0.0.1:5173', 
    'http://localhost:5174', 
    'http://127.0.0.1:5174', 
    'http://192.168.1.100:5173', 
    'http://192.168.1.100:5174',
    'https://youtube-chat-beryl.vercel.app',
    'https://youtube-chat-git-main-baqhtear.vercel.app',
    'https://youtube-chat-baqhtear.vercel.app'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper function to extract video ID from YouTube URL
function extractVideoId(url) {
  try {
    if (!url) return null;
    url = url.trim().replace(/^@/, '');
    
    const urlObj = new URL(url);
    let videoId = null;

    if (urlObj.hostname.includes('youtube.com')) {
      videoId = urlObj.searchParams.get('v');
    } else if (urlObj.hostname.includes('youtu.be')) {
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      videoId = pathParts[0]?.split('?')[0]; // Remove query parameters
    }

    return videoId && videoId.length === 11 ? videoId : null;
  } catch {
    return null;
  }
}

// Store transcripts and analysis in memory
const transcriptCache = new Map();
const videoAnalysisCache = new Map();

// Function to format duration in HH:MM:SS
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Function to chunk transcript into smaller parts with timestamps
function chunkTranscript(transcript) {
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;
  let totalDuration = 0;
  const MAX_CHUNK_LENGTH = 1500; // Increased for better context

  for (const item of transcript) {
    currentChunk.push(item);
    currentLength += item.text.length;
    totalDuration += item.duration || 0;

    if (currentLength >= MAX_CHUNK_LENGTH) {
      chunks.push({
        text: currentChunk.map(i => i.text).join(' '),
        startTime: currentChunk[0].offset,
        endTime: currentChunk[currentChunk.length - 1].offset + currentChunk[currentChunk.length - 1].duration,
        items: currentChunk
      });
      currentChunk = [];
      currentLength = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push({
      text: currentChunk.map(i => i.text).join(' '),
      startTime: currentChunk[0].offset,
      endTime: currentChunk[currentChunk.length - 1].offset + currentChunk[currentChunk.length - 1].duration,
      items: currentChunk
    });
  }

  return { chunks, totalDuration };
}

// Function to get relevant chunks for a timestamp or topic
function getRelevantChunks(chunks, query, analysis) {
  // If query contains a timestamp
  const timeRegex = /(\d{1,2}:)?(\d{1,2}:\d{2}|\d{1,2})/;
  const timeMatch = query.match(timeRegex);
  
  if (timeMatch) {
    const timestamp = timeMatch[0];
    const targetSeconds = timestamp.split(':').reduce((acc, val) => acc * 60 + parseInt(val), 0);
    const window = 300; // 5 minutes window
    
    return chunks.filter(chunk => {
      const chunkStart = chunk.startTime;
      const chunkEnd = chunk.endTime;
      return (chunkStart >= targetSeconds - window && chunkStart <= targetSeconds + window) ||
             (chunkEnd >= targetSeconds - window && chunkEnd <= targetSeconds + window);
    });
  }

  // If query mentions a topic or concept from analysis
  const topics = analysis.mainTopics.map(t => t.topic.toLowerCase());
  const concepts = analysis.keyConcepts.map(c => c.concept.toLowerCase());
  const queryLower = query.toLowerCase();
  
  const matchedTopic = topics.find(t => queryLower.includes(t));
  const matchedConcept = concepts.find(c => queryLower.includes(c));
  
  if (matchedTopic) {
    const topic = analysis.mainTopics.find(t => t.topic.toLowerCase() === matchedTopic);
    if (topic && topic.timestamp) {
      const targetSeconds = topic.timestamp.split(':').reduce((acc, val) => acc * 60 + parseInt(val), 0);
      const window = 300;
      return chunks.filter(chunk => {
        const chunkStart = chunk.startTime;
        const chunkEnd = chunk.endTime;
        return (chunkStart >= targetSeconds - window && chunkStart <= targetSeconds + window) ||
               (chunkEnd >= targetSeconds - window && chunkEnd <= targetSeconds + window);
      });
    }
  }

  // Return most relevant chunks based on text similarity
  return chunks.filter(chunk => {
    const chunkText = chunk.text.toLowerCase();
    const words = queryLower.split(' ').filter(w => w.length > 3);
    return words.some(word => chunkText.includes(word));
  });
}

// Function to create optimized chat context
function createChatContext(query, metadata, analysis, relevantChunks, language = 'en') {
  // Find relevant topics and concepts
  const queryLower = query.toLowerCase();
  const relevantTopics = analysis.mainTopics
    .filter(t => t.topic.toLowerCase().includes(queryLower) || queryLower.includes(t.topic.toLowerCase()))
    .slice(0, 3);
  
  const relevantConcepts = analysis.keyConcepts
    .filter(c => c.concept.toLowerCase().includes(queryLower) || queryLower.includes(c.concept.toLowerCase()))
    .slice(0, 3);

  // Create focused context based on language
  return language === 'ms'
    ? `Video: "${metadata.title}" (${formatDuration(metadata.duration)})

${relevantTopics.length > 0 ? `Topik Berkaitan:
${relevantTopics.map(t => `[${t.timestamp}] ${t.topic}: ${t.description}`).join('\n')}` : ''}

${relevantConcepts.length > 0 ? `Konsep Penting:
${relevantConcepts.map(c => `${c.concept}: ${c.definition}`).join('\n')}` : ''}

Bahagian transkrip yang berkaitan:
${relevantChunks.map(chunk => 
  `[${formatDuration(chunk.startTime)} - ${formatDuration(chunk.endTime)}]
${chunk.text}`).join('\n\n')}

Soalan: ${query}`
    : `Video: "${metadata.title}" (${formatDuration(metadata.duration)})

${relevantTopics.length > 0 ? `Relevant Topics:
${relevantTopics.map(t => `[${t.timestamp}] ${t.topic}: ${t.description}`).join('\n')}` : ''}

${relevantConcepts.length > 0 ? `Relevant Concepts:
${relevantConcepts.map(c => `${c.concept}: ${c.definition}`).join('\n')}` : ''}

Relevant transcript sections:
${relevantChunks.map(chunk => 
  `[${formatDuration(chunk.startTime)} - ${formatDuration(chunk.endTime)}]
${chunk.text}`).join('\n\n')}

Question: ${query}`;
}

// Function to analyze transcript and extract key concepts
async function analyzeTranscript(transcript, metadata, language = 'en') {
  const { chunks } = chunkTranscript(transcript);
  
  const fullTranscript = chunks.map(chunk => 
    `[${formatDuration(chunk.startTime)}] ${chunk.text}`
  ).join('\n');

  const systemPrompt = language === 'ms' 
    ? `Anda adalah penganalisis kandungan video yang tepat. Tugas anda adalah untuk:
       1. Menganalisis keseluruhan video dari awal hingga akhir
       2. Berikan timestamp yang tepat untuk semua poin utama
       3. Pastikan liputan menyeluruh tanpa jurang yang ketara
       4. Kembalikan hanya JSON yang sah tanpa markdown atau blok kod
       5. Simpan semua timestamp dalam format MM:SS atau HH:MM:SS
       6. Pastikan topik-topik diedarkan secara seimbang sepanjang video`
    : `You are a precise video content analyzer. Your task is to:
       1. Analyze the entire video from start to finish
       2. Provide accurate timestamps for all major points
       3. Ensure comprehensive coverage with no significant gaps
       4. Return only valid JSON with no markdown or code blocks
       5. Keep all timestamps in MM:SS or HH:MM:SS format
       6. Ensure even distribution of topics throughout the video length`;

  const analysisPrompt = language === 'ms'
    ? `Analisis video ${formatDuration(metadata.duration)} ini bertajuk "${metadata.title}".
       Video ini mengandungi ${chunks.length} segmen.

       Buat analisis komprehensif yang merangkumi KESELURUHAN durasi video dari awal hingga akhir.
       Bahagikan video kepada bahagian-bahagian yang logik dan kenalpasti saat-saat penting, pastikan tiada bahagian utama yang tertinggal.

       Keperluan:
       1. Kenalpasti topik/peristiwa setiap 2-3 minit
       2. Liputi keseluruhan video dari 0:00 hingga ${formatDuration(metadata.duration)}
       3. Sertakan topik tahap tinggi dan butiran khusus
       4. Catat semua peralihan utama antara topik
       5. Tangkap konsep utama semasa ia diperkenalkan
       6. Pastikan timestamp tepat dan diagihkan secara seimbang

       Berikut adalah transkrip lengkap:
       ${fullTranscript}

       Balas dengan HANYA objek JSON dalam format tepat ini (tanpa markdown, tanpa blok kod):
       {
         "summary": "Gambaran keseluruhan kandungan video",
         "mainTopics": [
           {
             "topic": "Nama topik atau bahagian tertentu",
             "timestamp": "MM:SS",
             "description": "Apa yang dibincangkan atau dipersembahkan"
           }
         ],
         "keyConcepts": [
           {
             "concept": "Istilah atau idea penting",
             "definition": "Penjelasan jelas tentang konsep"
           }
         ],
         "timeline": [
           {
             "time": "MM:SS",
             "event": "Peristiwa atau poin perbincangan tertentu"
           }
         ]
       }`
    : `Analyze this ${formatDuration(metadata.duration)} video titled "${metadata.title}".
       The video contains ${chunks.length} segments.

       Create a comprehensive analysis that covers the ENTIRE video duration from start to finish.
       Divide the video into logical sections and identify key moments, ensuring no major part is missed.

       Requirements:
       1. Identify a topic/event every 2-3 minutes
       2. Cover the full video length from 0:00 to ${formatDuration(metadata.duration)}
       3. Include both high-level topics and specific details
       4. Note all major transitions between topics
       5. Capture key concepts as they are introduced
       6. Ensure timestamps are accurate and evenly distributed

       Here's the full transcript:
       ${fullTranscript}

       Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
       {
         "summary": "Comprehensive overview of the entire video content",
         "mainTopics": [
           {
             "topic": "Specific topic or section name",
             "timestamp": "MM:SS",
             "description": "What is discussed or presented"
           }
         ],
         "keyConcepts": [
           {
             "concept": "Important term or idea",
             "definition": "Clear explanation of the concept"
           }
         ],
         "timeline": [
           {
             "time": "MM:SS",
             "event": "Specific event or discussion point"
           }
         ]
       }`;

  try {
    const analysis = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: analysisPrompt
        }
      ],
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    const responseText = analysis.choices[0].message.content;
    
    try {
      const parsedAnalysis = JSON.parse(responseText);
      
      // Validate and ensure coverage
      const timestamps = [
        ...parsedAnalysis.mainTopics.map(t => t.timestamp),
        ...parsedAnalysis.timeline.map(t => t.time)
      ].map(t => {
        const parts = t.split(':').map(Number);
        return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      }).sort((a, b) => a - b);

      // Check for gaps larger than 3 minutes
      const hasLargeGaps = timestamps.some((time, i) => {
        if (i === 0) return time > 180; // Check start
        return (time - timestamps[i-1]) > 180; // Check gaps
      });

      if (hasLargeGaps) {
        console.warn('Warning: Analysis contains gaps larger than 3 minutes');
      }

      return parsedAnalysis;
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      console.error('Response Text:', responseText);
      
      // Create a structured fallback analysis
      return {
        summary: `${metadata.title} - ${formatDuration(metadata.duration)} video analysis`,
        mainTopics: chunks.filter((_, i) => i % 3 === 0).map((chunk, i) => ({
          topic: `Section ${i + 1}`,
          timestamp: formatDuration(chunk.startTime),
          description: chunk.text.slice(0, 100) + '...'
        })),
        keyConcepts: [
          {
            concept: "Video Content",
            definition: "Main content of the video"
          }
        ],
        timeline: chunks.filter((_, i) => i % 2 === 0).map(chunk => ({
          time: formatDuration(chunk.startTime),
          event: chunk.text.slice(0, 50) + '...'
        }))
      };
    }
  } catch (error) {
    console.error('Analysis Error:', error);
    throw error;
  }
}

async function fetchVideoTranscript(videoId) {
  try {
    console.log('Attempting to fetch transcript for video:', videoId);
    const authClient = await auth.getClient();

    // First, get video details
    const videoResponse = await youtube.videos.list({
      auth: authClient,
      part: ['contentDetails', 'snippet'],
      id: [videoId]
    });

    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      throw new Error('Video not found');
    }

    const video = videoResponse.data.items[0];
    console.log('Video details:', {
      title: video.snippet.title,
      hasCaptions: video.contentDetails.caption === 'true'
    });

    // Get caption tracks using authenticated request
    const captionResponse = await youtube.captions.list({
      auth: authClient,
      part: ['snippet', 'id'],
      videoId: videoId
    });
    
    console.log('Caption tracks:', captionResponse.data);
    
    let transcriptText = null;
    let language = 'en';
    let captionType = 'auto';

    if (captionResponse.data.items && captionResponse.data.items.length > 0) {
      // Try each caption track
      for (const caption of captionResponse.data.items) {
        try {
          console.log('Trying caption track:', caption.snippet);
          
          // Try to download the caption track
          try {
            console.log('Attempting to download caption:', caption.id);
            const downloadResponse = await youtube.captions.download({
              auth: authClient,
              id: caption.id,
              tfmt: 'srt',
              prettyPrint: true
            });
            
            if (downloadResponse && downloadResponse.data) {
              console.log('Download successful, data length:', downloadResponse.data.length);
              transcriptText = downloadResponse.data;
              language = caption.snippet.language;
              captionType = caption.snippet.trackKind === 'ASR' ? 'auto' : 'manual';
              break;
            } else {
              console.log('Download response empty');
            }
          } catch (downloadError) {
            console.log('Failed to download caption:', downloadError.message);
            console.log('Download error details:', downloadError.response?.data || downloadError);
            
            // If OAuth download fails, try public endpoints as fallback
            const formats = [
              `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${caption.snippet.language}`,
              `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${caption.snippet.language}&fmt=srv3`,
              `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${caption.snippet.language}&kind=asr`
            ];

            for (const url of formats) {
              try {
                console.log('Trying public URL:', url);
                const response = await fetch(url);
                const text = await response.text();
                
                if (response.ok && text && text.length > 0 && (text.includes('<transcript>') || text.includes('<text'))) {
                  console.log('Found captions via public endpoint');
                  transcriptText = text;
                  language = caption.snippet.language;
                  captionType = caption.snippet.trackKind === 'ASR' ? 'auto' : 'manual';
                  break;
                }
              } catch (error) {
                console.log(`Failed to fetch from public endpoint:`, error.message);
              }
            }
          }

          if (transcriptText) break;
        } catch (error) {
          console.log(`Failed to process caption track:`, error.message);
        }
      }
    }

    // If still no transcript, try page scraping as last resort
    if (!transcriptText) {
      console.log('Attempting to fetch captions through page scraping');
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
      const html = await response.text();
      
      const captionDataMatch = html.match(/"captions":\s*({[^}]+})/);
      if (captionDataMatch) {
        try {
          const captionData = JSON.parse(captionDataMatch[1]);
          console.log('Found caption data in page source:', captionData);
          
          if (captionData.playerCaptionsTracklistRenderer?.captionTracks) {
            const tracks = captionData.playerCaptionsTracklistRenderer.captionTracks;
            for (const track of tracks) {
              try {
                const response = await fetch(track.baseUrl);
                const text = await response.text();
                if (response.ok && text && text.length > 0 && (text.includes('<transcript>') || text.includes('<text'))) {
                  transcriptText = text;
                  language = track.languageCode;
                  captionType = track.kind === 'asr' ? 'auto' : 'manual';
                  break;
                }
              } catch (error) {
                console.log('Failed to fetch caption track:', error.message);
              }
            }
          }
        } catch (error) {
          console.log('Failed to parse caption data:', error.message);
        }
      }
    }

    if (!transcriptText) {
      throw new Error('No captions found for this video');
    }

    // Parse the XML caption format
    const transcript = parseYouTubeCaption(transcriptText);
    
    return {
      transcript,
      language,
      captionType
    };
  } catch (error) {
    console.error('Final transcript fetch error:', error);
    throw new Error(
      `Failed to fetch transcript: ${error.message}. ` +
      'Please try another video or ensure the video has accessible captions.'
    );
  }
}

function parseYouTubeCaption(xmlString) {
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
    const textNodes = xmlDoc.getElementsByTagName('text');
    
    return Array.from(textNodes).map(node => {
      const start = parseFloat(node.getAttribute('start') || '0') * 1000;
      const duration = (parseFloat(node.getAttribute('dur') || '0')) * 1000;
      const text = node.textContent || '';
      
      return {
        text: text
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim(),
        offset: start,
        duration: duration || 2000 // Default duration if not provided
      };
    }).filter(item => item.text.length > 0);
  } catch (error) {
    console.error('Error parsing XML:', error);
    throw new Error('Failed to parse captions');
  }
}

app.post('/api/transcript', async (req, res) => {
  try {
    console.log('Received transcript request:', {
      url: req.body.url,
      headers: req.headers,
      timestamp: new Date().toISOString()
    });
    
    const { url } = req.body;
    
    if (!url) {
      console.log('URL missing in request');
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    console.log('Extracted video ID:', videoId);
    
    if (!videoId) {
      console.log('Invalid video ID extracted from URL:', url);
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Return cached data if available
    if (transcriptCache.has(videoId)) {
      console.log('Returning cached data for video:', videoId);
      const cachedData = transcriptCache.get(videoId);
      const analysis = videoAnalysisCache.get(videoId);
      return res.json({
        success: true,
        message: 'Transcript loaded from cache',
        metadata: cachedData.metadata,
        transcript: cachedData.transcript,
        analysis,
        language: cachedData.language,
        captionType: cachedData.captionType
      });
    }

    try {
      console.log('Fetching transcript for video:', videoId);
      const { transcript: transcriptResult, language, captionType } = await fetchVideoTranscript(videoId);
      console.log('Transcript fetch successful:', {
        language,
        captionType,
        transcriptLength: transcriptResult?.length || 0
      });

      // Process transcript and get total duration
      const { chunks, totalDuration } = chunkTranscript(transcriptResult);
      console.log('Processed transcript:', {
        chunks: chunks.length,
        totalDuration
      });

      // Try to fetch video title using oEmbed
      let videoTitle = 'YouTube Video';
      try {
        console.log('Fetching video metadata...');
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
        const oembedResponse = await fetch(oembedUrl);
        const oembedData = await oembedResponse.json();
        videoTitle = oembedData.title || videoTitle;
        console.log('Video metadata fetched:', { title: videoTitle });
      } catch (e) {
        console.error('Failed to fetch video title:', e);
      }

      const metadata = {
        title: videoTitle,
        duration: totalDuration,
        author: 'YouTube Creator'
      };

      // Analyze the transcript with detected language
      console.log('Starting transcript analysis...');
      const analysis = await analyzeTranscript(transcriptResult, metadata, language);
      console.log('Transcript analysis complete');

      // Store processed data
      const processedData = {
        metadata,
        transcript: transcriptResult,
        chunks,
        language,
        captionType
      };

      transcriptCache.set(videoId, processedData);
      videoAnalysisCache.set(videoId, analysis);
      console.log('Data cached for video:', videoId);

      console.log('Sending successful response');
      return res.json({
        success: true,
        message: `Transcript loaded successfully (${captionType === 'auto' ? 'Auto-generated' : 'Manual'} captions)`,
        metadata,
        transcript: transcriptResult,
        analysis,
        language,
        captionType
      });
    } catch (transcriptError) {
      console.error('Transcript fetch error details:', {
        error: transcriptError,
        message: transcriptError.message,
        stack: transcriptError.stack
      });
      throw new Error(
        'Failed to load video captions. ' +
        'Please ensure the video has either manual or auto-generated captions available.'
      );
    }
  } catch (error) {
    console.error('API error details:', {
      error: error,
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, videoId } = req.body;
    const cachedData = transcriptCache.get(videoId);
    const analysis = videoAnalysisCache.get(videoId);

    if (!cachedData || !analysis) {
      return res.status(400).json({ error: 'Transcript not found. Please load the video first.' });
    }

    const { metadata, chunks, language } = cachedData;
    
    // Get relevant chunks based on the query
    const relevantChunks = getRelevantChunks(chunks, message, analysis);
    
    // Create optimized context with detected language
    const contextPrompt = createChatContext(message, metadata, analysis, relevantChunks, language);

    const systemPrompt = language === 'ms'
      ? `Anda adalah pembantu yang membantu menjawab soalan tentang video YouTube.
         Gunakan analisis video dan bahagian transkrip yang disediakan.
         Sentiasa rujuk timestamp tertentu apabila membincangkan bahagian video.
         Jika maklumat tidak ada dalam konteks yang diberikan, nyatakan.
         Format timestamp sebagai [MM:SS] atau [HH:MM:SS] untuk video yang lebih panjang.
         Pastikan jawapan fokus dan ringkas sambil informatif.`
      : `You are a helpful assistant that answers questions about YouTube videos.
         Use the provided video analysis and relevant transcript sections.
         Always reference specific timestamps when discussing parts of the video.
         If the information isn't in the provided context, say so.
         Format timestamps as [MM:SS] or [HH:MM:SS] for longer videos.
         Keep responses focused and concise while being informative.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        { role: "user", content: contextPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    res.json({ response: completion.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process chat message: ' + error.message });
  }
});

// Add a test route
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is working!' });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 