'use strict';

// Fictional presentation records, loaded only by the explicit reset script.
const names = ['LeBron James', 'Stephen Curry', 'Luka Dončić', 'Giannis Antetokounmpo',
  'Nikola Jokić', 'Shai Gilgeous-Alexander', 'Anthony Edwards', 'Victor Wembanyama'];
const discussions = [
  {
    owner: 0, category: 'Academic Services', type: 'Suggestion', age: 118,
    title: 'A quiet study zone and a separate space for group work',
    description: 'Could we try designating one study area for quiet individual work and another for group discussions? Both are useful, especially between classes. A small two-week trial with clear signs would help us see whether the arrangement works before requesting more space. What hours would be most useful, and how could we keep the setup fair for everyone?',
    statuses: ['Under Review'], support: [0, 1, 2, 3, 4, 5, 6, 7], against: [],
    comments: [
      [2, 'A quiet section would help during my long break before afternoon classes. Please keep a few seats available for walk-ins instead of making everything reservation-only.'],
      [1, 'Good point. Group work still needs a place too. Could the discussion area be near the entrance, with the quieter desks farther inside?'],
      [0, 'That sounds more practical than asking everyone to stay silent everywhere. Maybe signs at the entrance could show which section is for which activity.'],
      [6, 'Can we include accessible seating in both sections? Students should not have to choose between an accessible desk and the kind of study space they need.'],
      [4, 'For the trial, we could collect short feedback at the end of each week: noise level, available seats, and whether groups could still work comfortably.'],
      [0, 'Agreed. The proposal should include walk-in seating, accessible desks, and a weekly feedback check. That gives us something concrete to evaluate.']
    ],
    response: 'Thank you for this proposal. It is under review while available study spaces, accessible seating, and a two-week trial schedule are assessed. We will share the next update after the space assessment.'
  },
  {
    owner: 1, category: 'Technology and Connectivity', type: 'Concern', age: 96,
    title: 'Could campus Wi-Fi have clearer login and connection guidance?',
    description: 'When a connection fails, it is difficult to tell whether the problem is the login page, the device, or the signal. Could we have a short connection guide and a simple way to report the location and time of a failed attempt? That would make reports more useful than just saying that the internet is slow. Please share useful troubleshooting steps without posting passwords or account details.',
    statuses: ['Under Review', 'In Progress'], support: [0, 1, 2, 4, 5, 6, 7], against: [],
    comments: [
      [5, 'A QR code near common study areas could link to the guide. It should also have a short printed address because the QR code is not useful if you cannot get online.'],
      [3, 'The report form could ask for the building, approximate time, and whether the login page opened. Those details would help identify patterns.'],
      [1, 'Yes, and it should distinguish no signal from connected but no internet. Those look similar to students but may have different causes.'],
      [6, 'Please include steps for both phones and laptops. A few screenshots would be easier to follow than a long technical explanation.'],
      [2, 'Could the guide also say what information not to share? A screenshot can accidentally include an email address or a saved password prompt.'],
      [1, 'I have added that to the idea: short device-specific steps, a location-and-time report, and a reminder to remove personal information from screenshots.']
    ],
    response: 'A draft connection guide and a checklist for reporting connection issues are being prepared. The guide will cover phones and laptops and explain how to report the location and time without sharing account details. This concern remains In Progress.'
  },
  {
    owner: 2, category: 'Student Services', type: 'Suggestion', age: 72,
    title: 'Show document requirements before students join a service queue',
    description: 'Could common student services have a one-page checklist of requirements, estimated processing steps, and where to ask questions? Students could check what they need before traveling or lining up. An online queue might help later, but a clear checklist seems like a smaller first step. How could we make the information easy to maintain and still available to students without mobile data?',
    statuses: ['Under Review'], support: [0, 1, 2, 3, 6, 7], against: [5],
    comments: [
      [5, 'I am less convinced about an online queue because students without data might lose their place. A printed checklist and a normal walk-in option would be more inclusive.'],
      [2, 'That is fair. The main request is the requirements checklist. Any future queue system should keep walk-ins and should not require a smartphone.'],
      [7, 'Please add a last-updated date and the responsible office to each checklist. Otherwise old copies may continue circulating.'],
      [4, 'Could it show separate lists for a first request and a follow-up? The documents needed may be different, and that is where a lot of confusion starts.'],
      [3, 'A printable version at the entrance would be useful. If something changes, the printed and online versions should be updated together.']
    ]
  },
  {
    owner: 3, category: 'Safety and Accessibility', type: 'Concern', age: 48,
    title: 'A simple way to report walkway lighting and access concerns',
    description: 'Could the feedback form offer a way to describe the exact walkway segment involved in a lighting or access concern? A nearby landmark, the time, and whether the path is difficult to use would make it easier to assess. I suggest starting with a location checklist rather than asking students to post photos of other people. What details would be useful without making a report difficult to submit?',
    statuses: [], support: [0, 2, 3, 4, 6], against: [],
    comments: [
      [6, 'Please include blocked ramps and uneven surfaces as optional items. Lighting matters, but access can be difficult even when the area is well lit.'],
      [0, 'A nearby landmark plus a brief description should be enough to start. Requiring an exact map pin could stop someone from submitting a useful report.'],
      [3, 'Agreed. Location description should be required, while a map pin or photo can stay optional. We should avoid uploading identifiable people.'],
      [7, 'It would also help to explain that urgent hazards should go directly to the appropriate campus contact. A discussion thread may not be seen immediately.']
    ]
  },
  {
    owner: 4, category: 'Campus Facilities', type: 'Complaint', age: 30,
    title: 'Waste segregation labels should show examples, not just colors',
    description: 'Students are unsure which bin to use for a food-stained paper container, a plastic cup, or leftover food. Could bin labels include simple examples and match the collection arrangement? Adding more bins alone may not help if the labels remain unclear. I would like to discuss a small trial in one busy area before proposing a campus-wide change.',
    statuses: [], support: [0, 1, 2, 4], against: [3, 7],
    comments: [
      [3, 'I would not support buying extra bins yet. If the collection process mixes everything later, new labels alone will not solve the problem.'],
      [4, 'I agree that collection needs to match. The trial could start by checking the current process, then improving the labels on existing bins.'],
      [2, 'Pictures would help, but the examples need to match what the collector accepts. A generic recycling symbol may be misleading.'],
      [7, 'Can the trial include a quick check after lunch? That would show whether the labels are helping at a busy time instead of only when the bins are empty.'],
      [4, 'Good suggestion. A small before-and-after check, agreed categories, and clear examples would give us a useful basis for deciding what to change.']
    ]
  },
  {
    owner: 6, category: 'Academic Services', type: 'Appreciation', age: 12,
    title: 'Short research guides make it easier to get started',
    description: 'A clear starting guide can make a research assignment feel much more manageable. I appreciate the short, practical guidance on finding sources, checking credibility, and keeping citation notes. Could we build on that with a beginner-friendly checklist and examples from different courses? What would have helped you most when starting your first research paper?',
    statuses: ['Under Review', 'Resolved'], support: [0, 1, 2, 3, 4, 5, 6], against: [],
    comments: [
      [0, 'A comparison between a topic and a research question would have helped me. It is easy to pick something interesting that is still too broad to investigate.'],
      [5, 'I would add an example of keeping source notes as you read. Rebuilding a reference list at the end takes much longer.'],
      [6, 'Those could be separate one-page guides so the first checklist stays short. Students could use the extra examples when they need them.'],
      [1, 'Please include accessible text versions alongside any posters. That makes the guide easier to read on a phone and with assistive tools.']
    ],
    response: 'Thank you for recognizing the research guidance. Your suggestions for a beginner checklist, source notes, and accessible text versions have been recorded for the next revision. This appreciation has been acknowledged and marked Resolved.'
  }
];

const privateSubmissions = [
  {
    owner: 5, category: 'Safety and Accessibility', type: 'Concern', age: 0.25,
    title: 'Flickering walkway light near the library entrance',
    description: 'The light along the covered walkway beside the library entrance has been flickering after late afternoon classes. The dim section makes it difficult to see the edge of the steps, especially when the pavement is wet. Please arrange an inspection of the light fixture and check whether the steps need a temporary warning sign while repairs are pending. The affected section is the first set of steps facing the main campus path.',
    statuses: []
  },
  {
    owner: 4, category: 'Campus Facilities', type: 'Complaint', age: 28,
    title: 'Leaking faucet and missing soap in the ground-floor restroom',
    description: 'One faucet in the ground-floor restroom near the student service area continues to drip even when closed, and the soap dispenser beside it is empty. The floor around the sink becomes wet during busy hours. Please check the faucet, refill the dispenser, and include this area in the next cleaning inspection. I am reporting the location so the maintenance team can identify the correct sink.',
    statuses: ['Under Review', 'In Progress'],
    response: 'The location and maintenance request have been recorded. Inspection of the faucet and replenishment of the dispenser are being coordinated. The report will remain In Progress until the repair and cleaning check are complete.'
  },
  {
    owner: 7, category: 'Student Services', type: 'Suggestion', age: 54,
    title: 'Add the registrar checklist beside the existing service window',
    description: 'Could a printed copy of the document requirements be placed beside the registrar service window? Students arriving without mobile data would be able to check the requirements before joining the queue. A large-print version with the responsible office and the date of the latest update would be helpful.',
    statuses: ['Under Review', 'Closed'],
    response: 'Thank you for the suggestion. This request has been consolidated with the existing document-requirements checklist proposal so both recommendations can be assessed together. This record is closed to avoid duplicate tracking; the main proposal remains Under Review.'
  },
  {
    owner: 0, category: 'Academic Services', type: 'General Feedback', age: 3,
    title: 'More time between laboratory sessions would help with equipment checks',
    description: 'The laboratory orientation was clear and the equipment checklist was useful. A short interval between consecutive sessions would give students enough time to return equipment, tidy the workstations, and check the next group in without rushing. Please consider reviewing the handover time when preparing the next laboratory schedule.',
    statuses: []
  }
];

module.exports = { names, discussions, privateSubmissions };
