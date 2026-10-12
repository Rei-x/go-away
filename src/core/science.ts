/** The reasoning behind the defaults. Mirrors docs/SCIENCE.md and is served by the MCP server. */
export const SCIENCE = {
  defaults: [
    {
      setting: "microBreak: 20 s every 20 min",
      why: "The 20-20-20 rule: every 20 minutes, look at something about 20 feet (6 m) away for 20 seconds. In a 2023 trial, people prompted to follow it reported less digital eye strain and dry-eye symptoms; the benefit faded once the reminders stopped, which argues for reminders that keep running.",
      sources: [
        "Talens-Estarelles C. et al. (2023). The effects of breaks on digital eye strain, dry eye and binocular vision: Testing the 20-20-20 rule. Contact Lens and Anterior Eye, 46(2), 101744. https://research.aston.ac.uk/en/publications/the-effects-of-breaks-on-digital-eye-strain-dry-eye-and-binocular/",
        "American Academy of Ophthalmology. Computers, Digital Devices and Eye Strain. https://www.aao.org/eye-health/tips-prevention/computer-usage",
      ],
    },
    {
      setting: "longBreak: 5 min every 60 min",
      why: "NIOSH field studies added four 5-minute breaks to data-entry workers' day (about one per hour). Discomfort and eye strain went down and productivity did not drop. A 2022 meta-analysis found that short breaks (10 min or less) reliably increase vigor and reduce fatigue, while performance effects are small and task dependent.",
      sources: [
        "Galinsky T.L. et al. (2000). A field study of supplementary rest breaks for data-entry operators. Ergonomics, 43(5), 622-638. https://stacks.cdc.gov/view/cdc/198356",
        "Galinsky T. et al. (2007). Supplementary breaks and stretching exercises for data entry operators: a follow-up field study. American Journal of Industrial Medicine, 50(7), 519-527. https://stacks.cdc.gov/view/cdc/186286",
        "Albulescu P. et al. (2022). 'Give me a break!' A systematic review and meta-analysis on the efficacy of micro-breaks for increasing well-being and performance. PLOS ONE, 17(8), e0272460. https://pmc.ncbi.nlm.nih.gov/articles/PMC9432722/",
      ],
    },
    {
      setting: "Break prompts suggest standing up and moving",
      why: "Interrupting sitting every 20 minutes with 2 minutes of light walking lowered post-meal glucose and insulin compared with uninterrupted sitting.",
      sources: [
        "Dunstan D.W. et al. (2012). Breaking up prolonged sitting reduces postprandial glucose and insulin responses. Diabetes Care, 35(5), 976-983. https://pmc.ncbi.nlm.nih.gov/articles/PMC3329818/",
      ],
    },
    {
      setting: "Defer breaks during meetings and calls; hold long breaks to the end of a focus block",
      why: "Interruptions in the middle of a task raise stress and frustration. Delivering them at a natural breakpoint instead reduces frustration and the time needed to resume. A meeting's end or a focus block's end is such a breakpoint.",
      sources: [
        "Mark G., Gudith D., Klocke U. (2008). The cost of interrupted work: more speed and stress. CHI 2008. https://www.ics.uci.edu/~gmark/chi08-mark.pdf",
        "Iqbal S.T., Bailey B.P. (2008). Effects of intelligent notification management on users and their tasks. CHI 2008. https://www.interruptions.net/literature/Iqbal-CHI08.pdf",
      ],
    },
  ],
  designChoices: [
    "Breaks cannot be skipped once they start. Reminder studies above show benefits depend on actually taking the breaks; the 20-20-20 effect disappeared when prompting stopped.",
    "Being idle for 5+ minutes (not in a call) counts as a long break: you were already away from the screen. This is a product choice, not a research finding.",
    "A long break due shortly before a meeting is pulled forward so it ends just before the meeting starts. Also a product choice.",
  ],
} as const;
