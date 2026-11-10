const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');
const {
  rankHooks,
  rankTitles,
  lintTitle,
  loadVoiceProfile,
  scriptRules,
  packagingRules,
  voiceBlock
} = require('../utils/youtube-skill-rules');

class ScriptWriterAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ScriptWriter');
    this.templates = this.loadTemplates();
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing Script Writer Agent...');
    return true;
  }

  loadTemplates() {
    return {
      tutorial: {
        structure: ['hook', 'introduction', 'problem', 'solution_steps', 'demonstration', 'recap', 'cta'],
        tone: 'educational',
        pacing: 'moderate'
      },
      explainer: {
        structure: ['hook', 'question', 'background', 'explanation', 'examples', 'implications', 'summary', 'cta'],
        tone: 'informative',
        pacing: 'steady'
      },
      list: {
        structure: ['hook', 'introduction', 'list_items', 'bonus_item', 'summary', 'cta'],
        tone: 'engaging',
        pacing: 'quick'
      },
      review: {
        structure: ['hook', 'introduction', 'overview', 'pros', 'cons', 'comparison', 'verdict', 'cta'],
        tone: 'analytical',
        pacing: 'detailed'
      },
      story: {
        structure: ['hook', 'setup', 'conflict', 'journey', 'climax', 'resolution', 'lesson', 'cta'],
        tone: 'narrative',
        pacing: 'dynamic'
      }
    };
  }

  async generateScript(strategy) {
    try {
      this.logger.info(`Generating script for: ${strategy.topic}`);
      
      const template = this.templates[strategy.contentType.toLowerCase()] || this.templates.explainer;
      const aiScript = await this.generateScriptWithAI(strategy, template);
      if (aiScript) {
        aiScript.fullScript = this.formatFullScript(aiScript);
        await this.db.saveScript(aiScript);
        this.logger.info(`Script generated with AI provider: ${aiScript.title}`);
        return aiScript;
      }
      
      this.logger.info('Using template script generation');
      // Generate script components
      const hook = await this.generateHook(strategy);
      const introduction = await this.generateIntroduction(strategy);
      const mainContent = await this.generateMainContent(strategy, template);
      const conclusion = await this.generateConclusion(strategy);
      const cta = await this.generateCTA(strategy);

      // Assemble complete script
      const script = {
        title: await this.generateTitle(strategy),
        hook,
        introduction,
        mainContent,
        conclusion,
        callToAction: cta,
        duration: this.estimateDuration(mainContent),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords,
        claims: [],
        metadata: {
          strategy: strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0'
        }
      };

      // Format for readability
      script.fullScript = this.formatFullScript(script);
      
      // Save to database
      await this.db.saveScript(script);
      
      this.logger.info(`Script generated: ${script.title}`);
      return script;
    } catch (error) {
      this.logger.error('Failed to generate script:', error);
      throw error;
    }
  }

  async generateScriptWithAI(strategy, template) {
    if (!this.aiTextService.isAvailable()) {
      this.logger.info('Using template script generation because no AI text provider is configured');
      return null;
    }

    const prompt = this.buildSkillScriptPrompt(strategy, template);

    try {
      const response = await this.aiTextService.generateText(prompt, {
        maxTokens: 4000,
        temperature: 0.7
      });
      const parsed = this.parseAIJsonResponse(response);
      const sections = this.normalizeAISections(parsed.sections, strategy);

      let rankedHooks = rankHooks(this.hookTexts(parsed));
      if (rankedHooks.length === 0 || !parsed.turn || sections.length === 0) {
        throw new Error('AI script response missing required fields (hooks, turn or sections)');
      }

      // yt-script: never hand over a weak hook. One rewrite pass aimed at the weakest property.
      if (rankedHooks[0].band === 'WEAK') {
        rankedHooks = await this.reviseWeakHooks(strategy, parsed, rankedHooks);
      }

      const packaging = this.selectPackaging(parsed, strategy);
      const bestHook = rankedHooks[0];
      const payoff = this.cleanSpoken(parsed.payoff);
      const ask = this.cleanSpoken(parsed.cta) || strategy.callToAction || `Subscribe for more on ${strategy.topic}.`;

      this.logger.info(`Using AI script generation via ${this.aiTextService.providerName}; hook ${bestHook.verdict}/100 (${bestHook.band}, ${bestHook.formula})`);
      return {
        title: packaging.title,
        hook: {
          type: bestHook.formulaId || 'ai',
          text: bestHook.hook,
          duration: '0:00-0:15',
          score: bestHook.verdict,
          band: bestHook.band,
          formula: bestHook.formula
        },
        // The turn replaces the old template intro: no greeting, no channel intro, no credibility filler.
        introduction: {
          greeting: '',
          topicIntro: this.cleanSpoken(parsed.turn),
          valueProposition: '',
          credibility: '',
          duration: '0:15-0:45'
        },
        mainContent: {
          sections,
          totalDuration: this.calculateSectionsDuration(sections)
        },
        conclusion: {
          type: 'conclusion',
          title: 'Payoff',
          recap: [],
          finalThought: payoff,
          duration: `${this.spokenSeconds(payoff)} seconds`
        },
        // yt-script: one ask, not three.
        callToAction: {
          type: 'call_to_action',
          subscribe: ask,
          like: '',
          comment: '',
          nextVideo: '',
          duration: `${this.spokenSeconds(ask)} seconds`
        },
        duration: this.estimateSpokenDuration([bestHook.hook, parsed.turn, ...sections.flatMap(s => s.content), payoff, ask]),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords || [],
        claims: this.normalizeAIClaims(parsed.claims, strategy.researchSources || []),
        packaging,
        metadata: {
          strategy,
          generatedAt: new Date().toISOString(),
          version: '2.0',
          generationSource: 'ai',
          editorialMethod: 'youtube-agent-skill/yt-script',
          voiceProfileUsed: Boolean(loadVoiceProfile()),
          hookCandidates: rankedHooks.map(hook => ({
            text: hook.hook,
            score: hook.verdict,
            band: hook.band,
            formula: hook.formula,
            weakest: hook.weakest,
            fix: hook.fix,
            properties: hook.properties
          })),
          formulaRationale: this.cleanSpoken(parsed.formulaRationale)
        }
      };
    } catch (error) {
      this.logger.warn(`AI script generation failed; using template fallback: ${error.message}`);
      return null;
    }
  }

  buildSkillScriptPrompt(strategy, template) {
    const voice = voiceBlock();
    return `You are writing a YouTube video script that a text-to-speech voice will narrate over generated visuals.
Return only valid JSON with this exact shape:
{
  "hooks": [
    { "text": "spoken hook, 9-24 words", "formula": "formula id from the list" }
  ],
  "formulaRationale": "one line: which formula the strongest hook uses and why it fits this idea",
  "titleOptions": ["ten different title options"],
  "thumbnailText": "max three words, sharing no word with the titles",
  "turn": "one spoken sentence saying what this video will do, then starting to do it",
  "sections": [
    {
      "title": "beat title",
      "content": ["spoken line", "spoken line"],
      "onScreen": "what the viewer sees during this beat, as a concrete visual description"
    }
  ],
  "payoff": "spoken lines that explicitly deliver what the hook promised",
  "cta": "one single spoken ask",
  "claims": [
    { "text": "specific factual claim a reviewer must verify", "riskLevel": "standard|high", "sourceUrls": ["exact supplied source URL"] }
  ]
}
Provide exactly five hooks and ten titleOptions. Use 3-8 sections.

${scriptRules()}

${packagingRules()}

${voice}

VIDEO BRIEF
Topic: ${strategy.topic}
Style/content type: ${strategy.contentType}
Angle: ${strategy.angle}
Target audience: ${strategy.targetAudience}
Desired length: ${strategy.requestedLength || process.env.DEFAULT_VIDEO_LENGTH || '8-12 minutes'} (about 150 spoken words per minute)
Tone: ${template.tone}
Pacing: ${template.pacing}
Brand voice: ${strategy.brandVoice || 'clear, credible, and engaging'}
Channel goal: ${strategy.channelGoal || 'help the viewer understand and act'}
Channel value proposition: ${strategy.channelValueProposition || 'give the viewer practical value'}
Editorial rationale: ${strategy.planRationale || 'fit the selected topic and audience'}
Channel constraints: ${strategy.channelConstraints || 'none beyond the factual-safety rules'}
Preferred call to action: ${strategy.callToAction || 'invite the viewer to subscribe'}
Keywords: ${(strategy.keywords || []).join(', ')}
Research sources: ${JSON.stringify(strategy.researchSources || [])}
Avoid fabricated statistics, unsupported claims, and fake urgency. List every externally verifiable factual claim in claims. Use only exact URLs from Research sources; use an empty sourceUrls array when the supplied sources do not support a claim.`;
  }

  hookTexts(parsed) {
    const hooks = Array.isArray(parsed.hooks) ? parsed.hooks : [];
    const texts = hooks.map(hook => (typeof hook === 'object' && hook !== null ? hook.text : hook));
    if (parsed.hook) texts.push(typeof parsed.hook === 'object' ? parsed.hook.text : parsed.hook);
    return texts.map(text => this.cleanSpoken(text)).filter(Boolean);
  }

  async reviseWeakHooks(strategy, parsed, rankedHooks) {
    const feedback = rankedHooks.slice(0, 5)
      .map(hook => `- "${hook.hook}" scored ${hook.verdict}/100 (${hook.band}); weakest ${hook.weakest}: ${hook.fix}`)
      .join('\n');
    const prompt = `Five YouTube hooks were scored and all are weak. Rewrite them.
Return only valid JSON: { "hooks": [ { "text": "spoken hook, 9-24 words", "formula": "formula id" } ] } with exactly five hooks.

Video topic: ${strategy.topic}
Angle: ${strategy.angle}
The turn that follows the hook: ${this.cleanSpoken(parsed.turn)}

Scores and the fix each one needs:
${feedback}

${scriptRules()}

${voiceBlock()}`;
    try {
      const response = await this.aiTextService.generateText(prompt, { maxTokens: 1200, temperature: 0.8 });
      const revised = rankHooks(this.hookTexts(this.parseAIJsonResponse(response)));
      const merged = [...rankedHooks, ...revised].sort((a, b) => b.verdict - a.verdict);
      this.logger.info(`Hook revision pass: best ${rankedHooks[0].verdict} -> ${merged[0].verdict}`);
      return merged;
    } catch (error) {
      this.logger.warn(`Hook revision pass failed; keeping the best original hook: ${error.message}`);
      return rankedHooks;
    }
  }

  selectPackaging(parsed, strategy) {
    const thumbnailText = this.cleanSpoken(parsed.thumbnailText)
      .split(/\s+/).filter(Boolean).slice(0, 3).join(' ').toUpperCase();
    const options = Array.isArray(parsed.titleOptions) ? parsed.titleOptions : [];
    if (parsed.title) options.push(parsed.title);
    const ranked = rankTitles(options, thumbnailText || null);
    const fallback = String(strategy.angle || strategy.topic || 'Untitled video').slice(0, 100);
    const best = ranked[0] || lintTitle(fallback, thumbnailText || null);
    return {
      title: best.title,
      titleScore: best.score,
      titleIssues: best.issues.map(issue => `${issue.code}: ${issue.message}`),
      thumbnailText,
      titleCandidates: ranked.slice(0, 3).map(item => ({
        title: item.title,
        score: item.score,
        issues: item.issues.map(issue => `${issue.code}: ${issue.message}`)
      }))
    };
  }

  cleanSpoken(value) {
    if (value === null || value === undefined) return '';
    const text = Array.isArray(value) ? value.join(' ') : (typeof value === 'object' ? value.text || '' : value);
    return String(text)
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[*_#`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  spokenSeconds(text) {
    const words = String(text || '').split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 2.5));
  }

  estimateSpokenDuration(lines) {
    const seconds = lines.reduce((total, line) => total + this.spokenSeconds(this.cleanSpoken(line)), 0);
    return this.formatDuration(seconds);
  }

  parseAIJsonResponse(response) {
    const text = String(response || '').trim();
    const withoutFences = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    try {
      return JSON.parse(withoutFences);
    } catch (error) {
      const match = withoutFences.match(/\{[\s\S]*\}/);
      if (!match) {
        throw error;
      }
      return JSON.parse(match[0]);
    }
  }

  normalizeAIHook(hook) {
    const text = typeof hook === 'object' && hook !== null ? hook.text : hook;
    return {
      type: 'ai',
      text: String(text).trim(),
      duration: '0:00-0:05'
    };
  }

  normalizeAISections(sections, strategy) {
    if (!Array.isArray(sections)) {
      return [];
    }

    return sections
      .slice(0, 8)
      .map((section, index) => {
        const rawContent = Array.isArray(section.content)
          ? section.content
          : [section.content || section.summary || section.description];
        const content = rawContent
          .filter(Boolean)
          .map(line => this.cleanSpoken(line))
          .filter(Boolean);
        const onScreen = this.cleanSpoken(section.onScreen || section.visual || section.visuals);
        // Duration from the words actually spoken (150 wpm), not the model's guess.
        const spoken = content.reduce((total, line) => total + this.spokenSeconds(line), 0);

        const normalized = {
          type: 'ai_generated',
          title: String(section.title || `${strategy.topic} Part ${index + 1}`).trim(),
          content,
          duration: spoken || parseInt(section.duration, 10) || 60
        };
        if (onScreen) {
          normalized.onScreen = onScreen;
          normalized.visuals = [onScreen];
        }
        return normalized;
      })
      .filter(section => section.title && section.content.length > 0);
  }

  normalizeAIClaims(claims, sources) {
    if (!Array.isArray(claims)) return [];
    const allowedUrls = new Set((sources || []).map(source => source.url));
    return claims.slice(0, 25).map(item => ({
      text: String(item?.text || item?.claim || '').trim().slice(0, 1000),
      riskLevel: item?.riskLevel === 'high' ? 'high' : 'standard',
      sourceUrls: [...new Set((Array.isArray(item?.sourceUrls) ? item.sourceUrls : [])
        .map(url => String(url))
        .filter(url => allowedUrls.has(url)))]
    })).filter(item => item.text);
  }

  normalizeAICTA(cta, strategy) {
    if (cta && typeof cta === 'object') {
      return {
        type: 'call_to_action',
        subscribe: String(cta.subscribe || cta.text || `Subscribe for more on ${strategy.topic}.`),
        like: String(cta.like || 'Like this video if it helped.'),
        comment: String(cta.comment || `Share your experience with ${strategy.topic} in the comments.`),
        nextVideo: String(cta.nextVideo || 'Watch the next related video for more context.'),
        duration: '15 seconds'
      };
    }

    return {
      type: 'call_to_action',
      subscribe: String(cta || `Subscribe for more practical videos about ${strategy.topic}.`),
      like: 'Like this video if it helped.',
      comment: `Share your experience with ${strategy.topic} in the comments.`,
      nextVideo: 'Watch the next related video for more context.',
      duration: '15 seconds'
    };
  }
  async generateTitle(strategy) {
    const templates = [
      `${strategy.angle}`,
      `${strategy.topic}: The Complete Guide`,
      `Everything You Need to Know About ${strategy.topic}`,
      `${strategy.topic} in ${new Date().getFullYear()}: What's Changed?`,
      `The Truth About ${strategy.topic} (Shocking Results)`,
      `How to Master ${strategy.topic} in 30 Days`,
      `${strategy.topic}: Beginner to Expert Guide`
    ];

    // Select based on content type
    if (strategy.contentType === 'Tutorial') {
      return `How to ${strategy.topic}: Step-by-Step Guide`;
    } else if (strategy.contentType === 'List') {
      return `Top 10 ${strategy.topic} Tips You Need to Know`;
    } else if (strategy.contentType === 'Review') {
      return `${strategy.topic} Review: Is It Worth It?`;
    }

    return templates[Math.floor(Math.random() * templates.length)];
  }

  async generateHook(strategy) {
    const hooks = [
      {
        type: 'question',
        text: `Have you ever wondered ${this.generateQuestionAbout(strategy.topic)}?`
      },
      {
        type: 'statistic',
        text: `Did you know that ${this.generateStatistic(strategy.topic)}?`
      },
      {
        type: 'statement',
        text: `${strategy.topic} is about to change everything, and here's why...`
      },
      {
        type: 'challenge',
        text: `Most people think they understand ${strategy.topic}, but they're completely wrong.`
      },
      {
        type: 'promise',
        text: `In the next few minutes, you'll learn exactly how to master ${strategy.topic}.`
      }
    ];

    const selected = hooks[Math.floor(Math.random() * hooks.length)];
    
    return {
      type: selected.type,
      text: selected.text,
      duration: '0:00-0:05'
    };
  }

  generateQuestionAbout(topic) {
    const questions = [
      `why ${topic} is becoming so important`,
      `how ${topic} actually works`,
      `what makes ${topic} different from everything else`,
      `why experts are talking about ${topic}`,
      `how ${topic} could change your life`
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }

  generateStatistic(topic) {
    const stats = [
      `many people are still figuring out how ${topic} works`,
      `the conversation around ${topic} keeps expanding`,
      `experts continue to debate where ${topic} is headed`,
      `people often miss the practical side of ${topic}`,
      `${topic} can be easier to approach with a clear framework`
    ];
    
    return stats[Math.floor(Math.random() * stats.length)];
  }

  async generateIntroduction(strategy) {
    return {
      greeting: "Hey everyone, welcome back to the channel!",
      topicIntro: `Today, we're diving deep into ${strategy.topic}.`,
      valueProposition: `By the end of this video, you'll understand exactly ${this.getValueProposition(strategy)}.`,
      credibility: this.getCredibilityStatement(strategy),
      duration: '0:05-0:20'
    };
  }

  getValueProposition(strategy) {
    const propositions = {
      'Tutorial': `how to implement ${strategy.topic} step by step`,
      'Explainer': `what ${strategy.topic} is and why it matters`,
      'List': `the most important things about ${strategy.topic}`,
      'Review': `whether ${strategy.topic} is right for you`,
      'Story': `the incredible journey of ${strategy.topic}`
    };
    
    return propositions[strategy.contentType] || `everything about ${strategy.topic}`;
  }

  getCredibilityStatement(_strategy) {
    const statements = [
      "I've spent months researching this topic",
      "After working with hundreds of people on this",
      "Based on the latest research and data",
      "Drawing from real-world experience",
      "Using proven methods and strategies"
    ];
    
    return statements[Math.floor(Math.random() * statements.length)];
  }

  async generateMainContent(strategy, template) {
    const sections = [];
    
    for (const section of template.structure) {
      if (!['hook', 'introduction', 'cta'].includes(section)) {
        sections.push(await this.generateSection(section, strategy));
      }
    }
    
    return {
      sections,
      totalDuration: this.calculateSectionsDuration(sections)
    };
  }

  async generateSection(sectionType, strategy) {
    const sectionGenerators = {
      problem: () => this.generateProblemSection(strategy),
      solution_steps: () => this.generateSolutionSteps(strategy),
      demonstration: () => this.generateDemonstration(strategy),
      explanation: () => this.generateExplanation(strategy),
      examples: () => this.generateExamples(strategy),
      list_items: () => this.generateListItems(strategy),
      pros: () => this.generatePros(strategy),
      cons: () => this.generateCons(strategy),
      comparison: () => this.generateComparison(strategy),
      implications: () => this.generateImplications(strategy)
    };

    const generator = sectionGenerators[sectionType];
    
    if (generator) {
      return await generator();
    }
    
    return this.generateGenericSection(sectionType, strategy);
  }

  async generateProblemSection(strategy) {
    return {
      type: 'problem',
      title: 'The Challenge',
      content: [
        `Many people struggle with ${strategy.topic}.`,
        `The main issues are:`,
        `1. Lack of clear information`,
        `2. Complexity and confusion`,
        `3. Not knowing where to start`,
        `But don't worry, we're going to solve all of these today.`
      ],
      visuals: ['Problem illustration', 'Statistics graphic'],
      duration: 30
    };
  }

  async generateSolutionSteps(strategy) {
    const steps = [];
    const numSteps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
    
    for (let i = 1; i <= numSteps; i++) {
      steps.push({
        number: i,
        title: `Step ${i}: ${this.generateStepTitle(strategy.topic, i)}`,
        description: this.generateStepDescription(strategy.topic, i),
        tip: this.generateProTip(strategy.topic)
      });
    }
    
    return {
      type: 'solution_steps',
      title: 'The Solution',
      steps,
      duration: steps.length * 45
    };
  }

  generateStepTitle(topic, stepNumber) {
    const titles = [
      'Research and Preparation',
      'Setting Up the Foundation',
      'Implementation and Execution',
      'Testing and Optimization',
      'Scaling and Automation'
    ];
    
    return titles[stepNumber - 1] || `Advanced ${topic} Techniques`;
  }

  generateStepDescription(topic, _stepNumber) {
    return `This step involves understanding the key aspects of ${topic} and how to apply them effectively. Pay special attention to the details here, as they make all the difference.`;
  }

  generateProTip(_topic) {
    const tips = [
      `Pro tip: Start small and scale gradually`,
      `Remember: Consistency is more important than perfection`,
      `Quick tip: Document everything as you go`,
      `Expert advice: Focus on one aspect at a time`,
      `Insider secret: This works best when combined with regular practice`
    ];
    
    return tips[Math.floor(Math.random() * tips.length)];
  }

  async generateDemonstration(_strategy) {
    return {
      type: 'demonstration',
      title: 'Live Demo',
      content: [
        `Now let me show you exactly how this works.`,
        `[Screen recording or visual demonstration]`,
        `As you can see, the process is straightforward once you understand the basics.`,
        `The key is to follow the steps exactly as shown.`
      ],
      visuals: ['Screen recording', 'Step-by-step graphics'],
      duration: 120
    };
  }

  async generateExplanation(strategy) {
    return {
      type: 'explanation',
      title: 'Deep Dive',
      content: [
        `Let's break down ${strategy.topic} into its core components.`,
        `First, we need to understand the fundamental principles.`,
        `The science behind this is fascinating...`,
        `[Detailed explanation with visuals]`,
        `This is why ${strategy.topic} works so effectively.`
      ],
      visuals: ['Diagrams', 'Infographics', 'Charts'],
      duration: 90
    };
  }

  async generateExamples(strategy) {
    return {
      type: 'examples',
      title: 'Real-World Examples',
      content: [
        `Let's look at some real examples of ${strategy.topic} in action.`,
        `Example 1: [Specific case study]`,
        `Example 2: [Another relevant example]`,
        `Example 3: [Third compelling example]`,
        `These examples show the versatility and power of ${strategy.topic}.`
      ],
      visuals: ['Case study graphics', 'Before/after comparisons'],
      duration: 75
    };
  }

  async generateListItems(strategy) {
    const items = [];
    const numItems = 5 + Math.floor(Math.random() * 6); // 5-10 items
    
    for (let i = 1; i <= numItems; i++) {
      items.push({
        number: numItems - i + 1, // Countdown for engagement
        title: this.generateListItemTitle(strategy.topic, i),
        description: this.generateListItemDescription(strategy.topic),
        impact: this.generateImpactStatement()
      });
    }
    
    return {
      type: 'list_items',
      title: `Top ${numItems} Things About ${strategy.topic}`,
      items,
      duration: items.length * 30
    };
  }

  generateListItemTitle(topic, index) {
    const titles = [
      `The Hidden Power of ${topic}`,
      `Why ${topic} Matters More Than You Think`,
      `The Surprising Truth About ${topic}`,
      `How ${topic} Can Transform Your Approach`,
      `The ${topic} Secret Nobody Talks About`,
      `Mastering ${topic} in Record Time`,
      `The Ultimate ${topic} Hack`,
      `${topic}: The Game Changer`,
      `Breaking Down ${topic} Myths`,
      `The Future of ${topic}`
    ];
    
    return titles[index - 1] || `Advanced ${topic} Technique #${index}`;
  }

  generateListItemDescription(topic) {
    return `This aspect of ${topic} is crucial because it fundamentally changes how we approach the subject. Understanding this will give you a significant advantage.`;
  }

  generateImpactStatement() {
    const impacts = [
      'This alone can save you hours',
      'Game-changing for beginners',
      'Essential for long-term success',
      'Often overlooked but critical',
      'The difference between success and failure'
    ];
    
    return impacts[Math.floor(Math.random() * impacts.length)];
  }

  async generatePros(_strategy) {
    return {
      type: 'pros',
      title: 'The Benefits',
      points: [
        'Easy to get started',
        'Cost-effective solution',
        'Proven results',
        'Scalable approach',
        'Community support'
      ],
      duration: 45
    };
  }

  async generateCons(_strategy) {
    return {
      type: 'cons',
      title: 'Things to Consider',
      points: [
        'Learning curve at the beginning',
        'Requires consistent effort',
        'Results may vary',
        'Some technical knowledge helpful'
      ],
      duration: 30
    };
  }

  async generateComparison(strategy) {
    return {
      type: 'comparison',
      title: 'How It Compares',
      content: `Compared to alternatives, ${strategy.topic} stands out because of its unique approach and proven effectiveness.`,
      comparisonPoints: [
        'More efficient than traditional methods',
        'Better ROI than competitors',
        'Easier to implement',
        'More sustainable long-term'
      ],
      duration: 60
    };
  }

  async generateImplications(strategy) {
    return {
      type: 'implications',
      title: 'What This Means',
      content: [
        `The implications of ${strategy.topic} are far-reaching.`,
        'This will change how we think about the industry.',
        'Early adopters will have a significant advantage.',
        'The potential for growth is enormous.'
      ],
      duration: 45
    };
  }

  generateGenericSection(sectionType, strategy) {
    return {
      type: sectionType,
      title: sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      content: `This section covers important aspects of ${strategy.topic} that you need to know.`,
      duration: 60
    };
  }

  async generateConclusion(strategy) {
    return {
      type: 'conclusion',
      title: 'Wrapping Up',
      recap: [
        `So that's everything you need to know about ${strategy.topic}.`,
        'We covered the key points:',
        '- The fundamentals and why they matter',
        '- Practical steps to get started',
        '- Real-world applications and examples',
        '- Tips for long-term success'
      ],
      finalThought: `Remember, ${strategy.topic} is a journey, not a destination. Keep learning and improving!`,
      duration: '30 seconds'
    };
  }

  async generateCTA(strategy) {
    return {
      type: 'call_to_action',
      subscribe: "If you found this helpful, make sure to subscribe and hit the notification bell!",
      like: "Give this video a thumbs up if you learned something new.",
      comment: `Let me know in the comments: What's your experience with ${strategy.topic}?`,
      nextVideo: "Check out this related video for more insights.",
      duration: '15 seconds'
    };
  }

  formatFullScript(script) {
    let fullScript = '';
    
    // Title
    fullScript += `TITLE: ${script.title}\n\n`;
    fullScript += '═'.repeat(50) + '\n\n';
    
    // Hook
    const hookScore = Number.isFinite(script.hook.score)
      ? ` (score ${script.hook.score}/100 ${script.hook.band}, ${script.hook.formula})`
      : '';
    fullScript += `[${script.hook.duration}] HOOK${hookScore}\n`;
    fullScript += `${script.hook.text}\n\n`;
    
    // Introduction
    fullScript += `[${script.introduction.duration}] ${script.metadata?.editorialMethod ? 'THE TURN' : 'INTRODUCTION'}\n`;
    [script.introduction.greeting, script.introduction.topicIntro, script.introduction.valueProposition, script.introduction.credibility]
      .filter(Boolean)
      .forEach(line => { fullScript += `${line}\n`; });
    fullScript += '\n';
    
    // Main Content
    fullScript += 'MAIN CONTENT\n';
    fullScript += '─'.repeat(30) + '\n\n';
    
    for (const section of script.mainContent.sections) {
      fullScript += `[${this.formatDuration(section.duration)}] ${section.title.toUpperCase()}\n`;
      
      if (Array.isArray(section.content)) {
        section.content.forEach(line => {
          fullScript += `${line}\n`;
        });
      } else if (section.steps) {
        section.steps.forEach(step => {
          fullScript += `\n${step.title}\n`;
          fullScript += `${step.description}\n`;
          fullScript += `💡 ${step.tip}\n`;
        });
      } else if (section.items) {
        section.items.forEach(item => {
          fullScript += `\n#${item.number}: ${item.title}\n`;
          fullScript += `${item.description}\n`;
          fullScript += `Impact: ${item.impact}\n`;
        });
      } else if (section.points) {
        section.points.forEach(point => {
          fullScript += `• ${point}\n`;
        });
      } else {
        fullScript += `${section.content}\n`;
      }
      
      if (section.visuals) {
        fullScript += `\n[VISUALS: ${section.visuals.join(', ')}]\n`;
      }
      
      fullScript += '\n';
    }
    
    // Conclusion
    fullScript += `[${script.conclusion.duration}] CONCLUSION\n`;
    script.conclusion.recap.forEach(line => {
      fullScript += `${line}\n`;
    });
    fullScript += `\n${script.conclusion.finalThought}\n\n`;
    
    // Call to Action
    fullScript += `[${script.callToAction.duration}] CALL TO ACTION\n`;
    [script.callToAction.subscribe, script.callToAction.like, script.callToAction.comment, script.callToAction.nextVideo]
      .filter(Boolean)
      .forEach(line => { fullScript += `${line}\n`; });
    fullScript += '\n';

    // Packaging and hook review (yt-script / yt-package)
    if (script.packaging?.thumbnailText) {
      fullScript += `THUMBNAIL TEXT: ${script.packaging.thumbnailText}\n`;
      fullScript += `TITLE SCORE: ${script.packaging.titleScore}/100${script.packaging.titleIssues.length ? ` (${script.packaging.titleIssues.join('; ')})` : ''}\n`;
    }
    if (Array.isArray(script.metadata?.hookCandidates) && script.metadata.hookCandidates.length > 1) {
      fullScript += 'HOOK OPTIONS:\n';
      script.metadata.hookCandidates.slice(0, 3).forEach(hook => {
        fullScript += `  ${hook.score}/100 ${hook.band} [${hook.formula}] ${hook.text}\n`;
      });
    }
    
    // Metadata
    fullScript += '═'.repeat(50) + '\n';
    fullScript += `ESTIMATED DURATION: ${script.duration}\n`;
    fullScript += `TONE: ${script.tone}\n`;
    fullScript += `PACING: ${script.pacing}\n`;
    fullScript += `KEYWORDS: ${script.keywords.join(', ')}\n`;
    
    return fullScript;
  }

  estimateDuration(mainContent) {
    const totalSeconds = mainContent.sections.reduce((total, section) => {
      return total + (section.duration || 60);
    }, 0);
    
    // Add hook, intro, conclusion, CTA
    const fullDuration = totalSeconds + 5 + 15 + 30 + 15;
    
    return this.formatDuration(fullDuration);
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  calculateSectionsDuration(sections) {
    return sections.reduce((total, section) => total + (section.duration || 60), 0);
  }
}

module.exports = { ScriptWriterAgent };
