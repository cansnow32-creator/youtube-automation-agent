const sharp = require('sharp');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');

class ThumbnailDesignerAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ThumbnailDesigner');
    this.templatesPath = path.join(__dirname, '..', 'data', 'thumbnail-templates');
  }

  async initialize() {
    this.logger.info('Initializing Thumbnail Designer Agent...');
    await this.ensureTemplatesDirectory();
    return true;
  }

  async ensureTemplatesDirectory() {
    try {
      await fs.mkdir(this.templatesPath, { recursive: true });
      await fs.mkdir(path.join(__dirname, '..', 'uploads', 'thumbnails'), { recursive: true });
    } catch (error) {
      this.logger.error('Failed to create directories:', error);
    }
  }

  async generateThumbnail(script, packagingLearning = null, assertLease = async () => {}) {
    const generatedPaths = [];
    let savedPath = null;
    try {
      await assertLease();
      this.logger.info(`Generating thumbnail for: ${script.title}`);

      const suffix = 'job_' + crypto.randomUUID();
      const concept = await this.generateConcept(script, packagingLearning);
      await assertLease();
      const prompt = await this.createPrompt(concept);
      await assertLease();

      const thumbnailPath = await this.createThumbnail(concept, suffix);
      generatedPaths.push(thumbnailPath);
      await assertLease();

      const finalThumbnail = await this.addTextOverlay(thumbnailPath, concept, suffix);
      generatedPaths.push(finalThumbnail);
      await assertLease();

      const optimizedThumbnail = await this.optimizeForYouTube(finalThumbnail, suffix);
      generatedPaths.push(optimizedThumbnail);
      await assertLease();

      const thumbnailData = {
        path: optimizedThumbnail,
        concept,
        prompt,
        dimensions: { width: 1280, height: 720 },
        fileSize: await this.getFileSize(optimizedThumbnail),
        createdAt: new Date().toISOString()
      };

      await assertLease();
      thumbnailData.id = await this.db.saveThumbnail(thumbnailData, assertLease.lease || null);
      // Keep the durable optimized file once its database row has been saved.
      savedPath = optimizedThumbnail;
      await assertLease();

      for (const generatedPath of generatedPaths) {
        if (generatedPath !== savedPath) await fs.unlink(generatedPath).catch(() => {});
      }
      this.logger.info('Thumbnail generated successfully');
      return thumbnailData;
    } catch (error) {
      for (const generatedPath of generatedPaths) {
        if (generatedPath !== savedPath) await fs.unlink(generatedPath).catch(() => {});
      }
      this.logger.error('Failed to generate thumbnail:', error);
      throw error;
    }
  }

  async generateConcept(script, packagingLearning = null) {
    const concepts = {
      tutorial: {
        style: 'clean',
        elements: ['step numbers', 'arrows', 'progress indicators'],
        colors: ['blue', 'white', 'green'],
        emotion: 'helpful'
      },
      explainer: {
        style: 'informative',
        elements: ['icons', 'diagrams', 'question marks'],
        colors: ['purple', 'yellow', 'white'],
        emotion: 'curious'
      },
      list: {
        style: 'numbered',
        elements: ['large numbers', 'countdown', 'highlights'],
        colors: ['red', 'yellow', 'black'],
        emotion: 'exciting'
      },
      review: {
        style: 'comparative',
        elements: ['product image', 'rating stars', 'vs symbol'],
        colors: ['orange', 'gray', 'white'],
        emotion: 'analytical'
      },
      story: {
        style: 'dramatic',
        elements: ['faces', 'emotion', 'journey path'],
        colors: ['dark blue', 'gold', 'white'],
        emotion: 'intriguing'
      }
    };

    const baseConcept = concepts[script.metadata?.strategy?.contentType?.toLowerCase()] || concepts.explainer;
    
    const concept = {
      title: this.formatThumbnailTitle(script.title),
      style: baseConcept.style,
      primaryText: this.extractPrimaryText(script.title),
      secondaryText: this.generateSecondaryText(script),
      elements: baseConcept.elements,
      colors: {
        primary: baseConcept.colors[0],
        secondary: baseConcept.colors[1],
        accent: baseConcept.colors[2]
      },
      emotion: baseConcept.emotion,
      composition: this.selectComposition(),
      effects: this.selectEffects()
    };

    // Reuse only the visual treatment proven by an explicitly adopted experiment.
    switch (packagingLearning?.winningThumbnailPattern) {
      case 'Color contrast':
        [concept.colors.primary, concept.colors.secondary] =
          [concept.colors.secondary, concept.colors.primary];
        break;
      case 'Alternate promise':
        concept.primaryText = this.generateAlternativeText(concept.primaryText);
        break;
      case 'Centered composition':
        concept.composition = 'centered';
        break;
      default:
        break;
    }
    return concept;
  }

  formatThumbnailTitle(title) {
    // Shorten title for thumbnail
    const words = title.split(' ');
    if (words.length > 5) {
      return words.slice(0, 5).join(' ') + '...';
    }
    return title;
  }

  extractPrimaryText(title) {
    // Extract most impactful words
    const impactWords = ['ultimate', 'complete', 'secret', 'truth', 'how', 'why', 'best', 'top', 'guide', 'master'];
    const titleWords = title.toLowerCase().split(' ');
    
    const foundImpactWords = titleWords.filter(word => impactWords.includes(word));
    
    if (foundImpactWords.length > 0) {
      return foundImpactWords[0].toUpperCase();
    }
    
    // Extract numbers if present
    const numbers = title.match(/\d+/);
    if (numbers) {
      return numbers[0];
    }
    
    // Use first significant word
    return titleWords.find(word => word.length > 4)?.toUpperCase() || 'WATCH';
  }

  generateSecondaryText(script) {
    if (script.metadata && script.metadata.strategy) {
      const strategy = script.metadata.strategy;
      
      if (strategy.contentType === 'Tutorial') {
        return 'STEP BY STEP';
      } else if (strategy.contentType === 'List') {
        return 'YOU WON\'T BELIEVE #1';
      } else if (strategy.contentType === 'Review') {
        return 'HONEST REVIEW';
      }
    }
    
    return 'MUST WATCH';
  }

  selectComposition() {
    const compositions = [
      'rule-of-thirds',
      'centered',
      'diagonal',
      'golden-ratio',
      'symmetrical'
    ];
    
    return compositions[Math.floor(Math.random() * compositions.length)];
  }

  selectEffects() {
    return {
      blur: Math.random() > 0.5,
      vignette: Math.random() > 0.7,
      glow: Math.random() > 0.6,
      shadow: true,
      border: Math.random() > 0.8
    };
  }

  async createPrompt(concept) {
    const prompt = `Create a YouTube thumbnail with the following specifications:
    Style: ${concept.style}
    Primary Text: "${concept.primaryText}"
    Secondary Text: "${concept.secondaryText}"
    Color Scheme: ${concept.colors.primary}, ${concept.colors.secondary}, ${concept.colors.accent}
    Elements to include: ${concept.elements.join(', ')}
    Emotional tone: ${concept.emotion}
    Composition: ${concept.composition}
    
    The thumbnail should be eye-catching, professional, and optimized for high click-through rate.
    Resolution: 1280x720px
    Format: High contrast, bold text, clear imagery`;
    
    return prompt;
  }

  async createThumbnail(concept, suffix = '') {
    // Create a base thumbnail using Sharp
    const width = 1280;
    const height = 720;
    
    const marker = suffix ? `_${suffix}` : '';
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail${marker}_${Date.now()}.png`);
    
    // Create gradient background
    const svg = `
      <svg width="${width}" height="${height}">
        <defs>
          <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${this.hexToRgb(concept.colors.primary)};stop-opacity:1" />
            <stop offset="100%" style="stop-color:${this.hexToRgb(concept.colors.secondary)};stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#gradient)" />
      </svg>
    `;
    
    try {
      await sharp(Buffer.from(svg))
        .resize(width, height)
        .png()
        .toFile(outputPath);
      return outputPath;
    } catch (error) {
      await fs.unlink(outputPath).catch(() => {});
      throw error;
    }
  }

  hexToRgb(color) {
    // Color name to hex mapping
    const colors = {
      'blue': '#0066CC',
      'red': '#CC0000',
      'green': '#00CC66',
      'yellow': '#FFCC00',
      'purple': '#6600CC',
      'orange': '#FF6600',
      'white': '#FFFFFF',
      'black': '#000000',
      'gray': '#808080',
      'dark blue': '#003366',
      'gold': '#FFD700'
    };
    
    return colors[color] || '#000000';
  }

  async addTextOverlay(imagePath, concept, suffix = '') {
    const marker = suffix ? `_${suffix}` : '';
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_final${marker}_${Date.now()}.png`);
    
    // Create text overlay SVG
    const textSvg = `
      <svg width="1280" height="720">
        <style>
          .primary { 
            fill: ${concept.colors.accent === 'white' ? 'white' : 'black'}; 
            font-size: 120px; 
            font-weight: bold; 
            font-family: Arial, sans-serif;
            text-anchor: middle;
          }
          .secondary { 
            fill: ${concept.colors.accent}; 
            font-size: 60px; 
            font-weight: bold; 
            font-family: Arial, sans-serif;
            text-anchor: middle;
          }
          .shadow {
            fill: black;
            opacity: 0.5;
          }
        </style>
        
        <!-- Shadow -->
        <text x="642" y="302" class="primary shadow">${concept.primaryText}</text>
        <text x="642" y="402" class="secondary shadow">${concept.secondaryText}</text>
        
        <!-- Main text -->
        <text x="640" y="300" class="primary">${concept.primaryText}</text>
        <text x="640" y="400" class="secondary">${concept.secondaryText}</text>
      </svg>
    `;
    
    const textOverlay = await sharp(Buffer.from(textSvg)).png().toBuffer();
    
    try {
      await sharp(imagePath)
        .composite([{
          input: textOverlay,
          top: 0,
          left: 0
        }])
        .toFile(outputPath);
      return outputPath;
    } catch (error) {
      await fs.unlink(outputPath).catch(() => {});
      throw error;
    }
  }

  async optimizeForYouTube(imagePath, suffix = '') {
    const marker = suffix ? `_${suffix}` : '';
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_optimized${marker}_${Date.now()}.jpg`);
    
    try {
      // YouTube optimization: JPEG format, proper compression
      await sharp(imagePath)
        .resize(1280, 720, {
          fit: 'cover',
          position: 'centre'
        })
        .jpeg({
          quality: 90,
          progressive: true,
          optimizeScans: true
        })
        .toFile(outputPath);

      // Verify file size (YouTube limit is 2MB)
      const stats = await fs.stat(outputPath);
      if (stats.size > 2 * 1024 * 1024) {
        // Re-compress if too large
        await sharp(imagePath)
          .resize(1280, 720)
          .jpeg({ quality: 80 })
          .toFile(outputPath);
      }
      return outputPath;
    } catch (error) {
      await fs.unlink(outputPath).catch(() => {});
      throw error;
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  async generateABVariants(concept, assertLease = async () => {}) {
    const generatedPaths = [];
    const variants = [];
    try {
      const concepts = [
        {
          label: 'Color contrast',
          concept: {
            ...concept,
            colors: {
              primary: concept.colors.secondary,
              secondary: concept.colors.primary,
              accent: concept.colors.accent
            }
          }
        },
        {
          label: 'Alternate promise',
          concept: { ...concept, primaryText: this.generateAlternativeText(concept.primaryText) }
        },
        {
          label: 'Centered composition',
          concept: { ...concept, composition: 'centered' }
        }
      ];

      for (let index = 0; index < concepts.length; index++) {
        await assertLease();
        const { label, concept: variantConcept } = concepts[index];
        const suffix = 'experiment_' + crypto.randomUUID() + '_' + (index + 1);
        const base = await this.createThumbnail(variantConcept, suffix);
        generatedPaths.push(base);
        await assertLease();
        const overlay = await this.addTextOverlay(base, variantConcept, suffix);
        generatedPaths.push(overlay);
        await assertLease();
        const optimized = await this.optimizeForYouTube(overlay, suffix);
        generatedPaths.push(optimized);
        await assertLease();
        variants.push({ label, path: optimized, concept: variantConcept });
      }

      const publishedPaths = new Set(variants.map(variant => variant.path));
      for (const generatedPath of generatedPaths) {
        if (!publishedPaths.has(generatedPath)) await fs.unlink(generatedPath).catch(() => {});
      }
      return variants;
    } catch (error) {
      for (const generatedPath of generatedPaths) await fs.unlink(generatedPath).catch(() => {});
      throw error;
    }
  }

  generateAlternativeText(originalText) {
    const alternatives = {
      'HOW': 'WHY',
      'BEST': 'TOP',
      'GUIDE': 'SECRETS',
      'TRUTH': 'FACTS',
      'ULTIMATE': 'COMPLETE'
    };
    
    return alternatives[originalText] || originalText + '!';
  }
}

module.exports = { ThumbnailDesignerAgent };
