from pathlib import Path
import re
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.enums import TA_LEFT
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/pdf/CSPConnect_10_Minute_Presentation_Script.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont('Arial', 'C:/Windows/Fonts/arial.ttf'))
pdfmetrics.registerFont(TTFont('Arial-Bold', 'C:/Windows/Fonts/arialbd.ttf'))
pdfmetrics.registerFont(TTFont('Arial-Italic', 'C:/Windows/Fonts/ariali.ttf'))
pdfmetrics.registerFontFamily('Arial', normal='Arial', bold='Arial-Bold', italic='Arial-Italic')
INK = colors.HexColor('#182B3B')
MUTED = colors.HexColor('#536777')
TEAL = colors.HexColor('#087E83')
PALE = colors.HexColor('#EFF7F7')
LINE = colors.HexColor('#D6E2E7')
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='TitleMain', fontName='Arial-Bold', fontSize=24, leading=27, textColor=INK, spaceAfter=6))
styles.add(ParagraphStyle(name='Kicker', fontName='Arial-Bold', fontSize=9, leading=11, textColor=TEAL, spaceAfter=7))
styles.add(ParagraphStyle(name='Sub', fontName='Arial', fontSize=10, leading=13, textColor=MUTED, spaceAfter=9))
styles.add(ParagraphStyle(name='BodyScript', fontName='Arial', fontSize=10.5, leading=14, textColor=INK, spaceAfter=6))
styles.add(ParagraphStyle(name='Cue', fontName='Arial', fontSize=8.8, leading=11.5, textColor=MUTED))
styles.add(ParagraphStyle(name='BlockTitle', fontName='Arial-Bold', fontSize=10.5, leading=14, textColor=TEAL, spaceBefore=7, spaceAfter=4))
styles.add(ParagraphStyle(name='SmallNote', fontName='Arial', fontSize=9, leading=12.5, textColor=MUTED, spaceAfter=5))
styles.add(ParagraphStyle(name='TableText', fontName='Arial', fontSize=10, leading=14, textColor=INK))
styles.add(ParagraphStyle(name='TableHead', fontName='Arial-Bold', fontSize=9, leading=12, textColor=TEAL))

story = []
spoken = {'intro': [], 'Anna': [], 'Angelica': [], 'Sam': []}

def p(text, style='BodyScript'):
    return Paragraph(text, styles[style])

def title(kicker, heading, subtitle):
    story.extend([p(kicker, 'Kicker'), p(heading, 'TitleMain'), p(subtitle, 'Sub')])

def cue(text):
    box = Table([[p('<b>ON SCREEN</b>  ' + text, 'Cue')]], colWidths=[505])
    box.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), PALE), ('BOX', (0, 0), (-1, -1), 0.5, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 10), ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    return box

def block(who, timing, heading, action, speech):
    spoken[who].append(speech)
    story.append(KeepTogether([
        p(timing + '  |  ' + heading, 'BlockTitle'), cue(action), Spacer(1, 5), p(speech)
    ]))

def sample(label, text):
    story.extend([p(label, 'BlockTitle'), cue(text), Spacer(1, 3)])

title('PRESENTATION SCRIPT  /  OCTOBER 21, 2026', 'CSPConnect',
      '10 minutes total. A functional walkthrough with spoken lines and screen actions. No coding discussion.')

schedule = [
    [p('CLOCK', 'TableHead'), p('SPEAKER', 'TableHead'), p('FOCUS', 'TableHead')],
    [p('0:00 - 1:00', 'TableText'), p('Sam only', 'TableText'), p('Full introduction', 'TableText')],
    [p('1:00 - 4:00', 'TableText'), p('Anna', 'TableText'), p('Submit Feedback and My Feedback', 'TableText')],
    [p('4:00 - 7:00', 'TableText'), p('Angelica', 'TableText'), p('Dashboard and Emergency Assistance', 'TableText')],
    [p('7:00 - 10:00', 'TableText'), p('Sam', 'TableText'), p('Aizen AI, Community Feed, and closing', 'TableText')],
]
t = Table(schedule, colWidths=[100, 92, 313])
t.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), PALE), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ('LINEBELOW', (0, 0), (-1, -1), 0.4, LINE),
    ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
    ('LEFTPADDING', (0, 0), (-1, -1), 8),
]))
story.extend([t, Spacer(1, 8)])

story.append(p('0:00 - 1:00  |  Sam only - introduction', 'BlockTitle'))
for speech in [
    'Good day, everyone. I am Sam, and together with Angelica and Anna, we are presenting CSPConnect, our campus feedback and community portal. The system gives students a clear way to share concerns, follow their submissions, and participate in campus discussions.',
    'Today, we will focus on how to use its functions. Anna will demonstrate Submit Feedback and My Feedback. Angelica will explain the Dashboard and Emergency Assistance. I will demonstrate Aizen AI and the Community Feed. We will show the actual steps on screen, from entering a concern to tracking its progress and joining a discussion. To begin, I will turn the presentation over to Anna.',
]:
    spoken['intro'].append(speech)
    story.append(p(speech))
story.append(p('Timing: Sam speaks for 4 minutes total - 1 minute for this introduction plus 3 minutes for Aizen AI and Community Feed. Anna and Angelica each have 3 minutes. Total: 10 minutes.', 'SmallNote'))

story.append(p('BEFORE THE TIMER STARTS', 'BlockTitle'))
for text in [
    'Sign in beforehand using separate browser profiles or browsers for the student, administrator, and security accounts. Keep the relevant pages open.',
    'Pre-fill Anna\'s feedback form and Angelica\'s emergency form, but do not submit yet. Announce that the emergency is a presentation scenario; keep the call button as a visual example.',
    'Use a stopwatch. The time blocks include clicks and loading. Read only the spoken paragraphs; the shaded boxes are action cues. If loading is slow, explain the step and continue at the next time mark.',
]:
    story.append(p('- ' + text, 'SmallNote'))

story.append(PageBreak())
title('ANNA  /  1:00 - 4:00  /  3 MINUTES', 'Submit Feedback and My Feedback',
      'Student functions only: create a submission, find its reference, and track its progress.')

block('Anna', '1:00 - 2:00', 'Create a submission',
      'Student profile: open Submit Feedback. Point to each pre-filled field, then click Submit Feedback. Leave Submit anonymously unchecked for this walkthrough.',
      'To send feedback, the student selects Submit Feedback. First, choose a feedback type: Suggestion, Complaint, Concern, General Feedback, or Appreciation. Next, choose the category so the issue is organized under the correct campus area. Enter a clear title and describe what happened, where it happened, and what action would help. For this example, I am reporting an unreliable Wi-Fi connection in the library. An image is optional. The anonymous option hides the name in the Community Feed, while the submission stays linked to the account for private tracking. I will now submit it.')

sample('PRE-FILLED EXAMPLE',
       '<b>Type:</b> Concern &nbsp; <b>Category:</b> Technology and Connectivity<br/>'
       '<b>Title:</b> Weak Wi-Fi signal in the library reading area<br/>'
       '<b>Description:</b> The campus Wi-Fi in the library reading area frequently disconnects between 1:00 and 3:00 PM, interrupting access to course materials. Please check the signal and advise students on connection steps.')

block('Anna', '2:00 - 2:45', 'Find your submission in My Feedback',
      'Point to the confirmation and new reference number. Open My Feedback, enter part of the title in Search, apply the Concern type filter, and open the new record.',
      'After submission, the system displays a confirmation and a unique reference number. Keep this reference so you can identify the correct concern. Next, open My Feedback. This page lists the submissions linked to the signed-in student account. Search helps find a title or reference number, while the type, category, and status filters narrow the list. I will search for our library Wi-Fi concern and open it to see the details. This keeps the student\'s submissions easy to find and follow.')

block('Anna', '2:45 - 3:40', 'Read the status, history, and responses',
      'Stay in the student profile. Point to Submitted, the saved details, status history, and Official responses. For this new record, explain that a response appears after review; no administrator actions are needed.',
      'The detail page shows the saved concern and its current status. Submitted means the system has received it. Under Review means it is being assessed. In Progress means action is underway. Resolved means the issue has been addressed, while Closed means the record has been closed. The status history shows recorded updates over time. Official responses appear here when the administrator replies. Our new submission is still Submitted, so we should not expect a response yet. The student returns to this same record to check future updates. Submitting feedback does not automatically publish it to the Community Feed.')

block('Anna', '3:40 - 4:00', 'Handoff to Angelica',
      'Leave My Feedback visible, then switch to the Dashboard for Angelica.',
      'These two functions work together: Submit Feedback sends the concern, and My Feedback lets the student find it again and follow the response. Angelica will now demonstrate the Dashboard and Emergency Assistance.')

story.append(PageBreak())
title('ANGELICA  /  4:00 - 7:00  /  3 MINUTES', 'Dashboard and emergencies',
      'Show what users can monitor, then follow one report from submission to resolution.')

block('Angelica', '4:00 - 4:45', 'Read the dashboard',
      'Show the student Dashboard, then the administrator Dashboard. Point to the totals and recent submissions; do not read every record.',
      'The student dashboard is a quick overview of the account. It shows total submissions and how many are Under Review, In Progress, or Resolved. Recent feedback provides shortcuts to individual records, while Submit Feedback opens the form Anna demonstrated. The administrator dashboard summarizes all recorded feedback, including Submitted and Closed items, and highlights submissions requiring attention. These figures help users see progress without opening every record individually.')

block('Angelica', '4:45 - 5:50', 'Submit an emergency report',
      'Student profile: open Emergency Assistance and show the prepared form. Point to the guardhouse contact area, then click Submit Emergency Report. Do not place a call.',
      'Emergency Assistance is for a situation needing attention from campus security. This is a presentation scenario. To report one, select the emergency type, such as Medical, Fire, Accident, Security Threat, or Other. Enter a specific location and briefly describe what happened. A contact number is optional, but it can help security reach the reporter. I will submit the prepared medical report now. The system opens its details with a Submitted status. The student can also view their reports and history from this page. For immediate help, the guardhouse call option is available when a verified contact number is configured.')

sample('PRE-FILLED EMERGENCY EXAMPLE',
       '<b>Type:</b> Medical &nbsp; <b>Location:</b> Library entrance, beside the main steps<br/>'
       '<b>What happened?</b> A student feels dizzy and is seated near the library entrance. Assistance is requested. A companion is staying with the student.<br/>'
       '<b>Contact number:</b> Leave blank for this presentation.')

block('Angelica', '5:50 - 6:45', 'Show the security response',
      'Security profile: show the incoming alert and Emergency Dashboard. Click Respond to Emergency, then Mark Resolved. Show the student report updating, and point to View history.',
      'On the security account, the report appears in the Emergency Dashboard. An incoming alert draws attention to reports needing a response; alarm sound depends on the browser allowing audio. Security can review the type, location, and description, then select Respond to Emergency. The status changes to Responding, showing that the report has been accepted for action. Once the situation is handled, security selects Mark Resolved. The student can follow these changes, and the status history keeps a record of the report. Completed reports are available through View history.')

block('Angelica', '6:45 - 7:00', 'Handoff',
      'Leave the completed report visible, then switch to the student Aizen page.',
      'This connects the student report with the security response. It gives both sides a clear view of the report and its progress. Sam will now demonstrate Aizen AI and the Community Feed.')

story.append(PageBreak())
title('SAM  /  7:00 - 10:00  /  3 MINUTES', 'Aizen AI and Community Feed',
      'Guide users through the portal, then show how students participate in campus discussions.')

block('Sam', '7:00 - 8:10', 'Ask Aizen for help',
      'Student profile: open Aizen Assistant. Select "What do the feedback statuses mean?" or type that question, then click Send message. Let the answer appear and point to one relevant part.',
      'Aizen is the system\'s AI assistant. Students can use it when they need help with the portal, such as choosing a feedback type, understanding anonymous submissions, or tracking a reference number. I will ask: What do the feedback statuses mean? After sending the message, Aizen explains the workflow in a conversational format. Students can also use the suggested questions as starting points. Aizen provides guidance; official decisions about a submission come from the administrator\'s response. If Aizen is temporarily unavailable, the student can still submit feedback and track it through the navigation menu.')

block('Sam', '8:10 - 8:45', 'Browse the feed',
      'Open Community Feed. Show the NBA-named posts and the three sorting choices. Open Stephen Curry\'s existing published Wi-Fi discussion; Anna\'s new submission remains private.',
      'The Community Feed contains feedback approved for publication by an administrator. Students can search, filter by feedback type, and choose a sorting option. Newest shows recent submissions. Most Supported ranks by total Support reactions. Trending highlights feedback gaining Support during the past seven days. Opening a post shows its description, status, author display, reactions, and discussion.')

block('Sam', '8:45 - 9:40', 'React, comment, and moderate',
      'As a student, click Support, click it again to remove it, then select Support once more. Post the prepared comment. Point to the administrator Comments menu in the other profile without moderating this comment.',
      'A student can select Support or Not Helpful. Only one reaction is active per student on a post. Clicking the same reaction removes it, while choosing the other switches it. The counts update to reflect the saved selection. Students can also add a constructive comment. For example: A connection guide near the reading area would help students troubleshoot before reporting a problem. This adds useful detail to the discussion. Administrators can hide or restore comments through the Comments page and remove a post from the feed when necessary. Community reactions do not automatically change a submission\'s official status.')

sample('COMMENT TO PREPARE',
       'A connection guide near the reading area would help students troubleshoot before reporting a problem.')

block('Sam', '9:40 - 10:00', 'Close the presentation',
      'Leave the Community Feed visible. Finish by 10:00.',
      'That completes our walkthrough of CSPConnect: submitting and tracking feedback, monitoring the dashboard, reporting emergencies, getting guidance from Aizen, and participating in community discussions. Together, these functions give students a clear way to share concerns and follow the response. Thank you for listening.')

def footer(canvas, doc):
    width, height = doc.pagesize
    canvas.setStrokeColor(LINE)
    canvas.line(45, 37, width - 45, 37)
    canvas.setFont('Arial', 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(45, 24, 'CSPConnect  |  Presenter copy  |  Read paragraphs; follow shaded action cues')
    canvas.drawRightString(width - 45, 24, f'{doc.page} / 4')

doc = SimpleDocTemplate(str(OUT), pagesize=(595.28, 841.89), rightMargin=45, leftMargin=45,
                        topMargin=37, bottomMargin=50, title='CSPConnect - 10 Minute Presentation Script',
                        author='CSPConnect | Sam, Angelica, Anna', subject='Timed functional system walkthrough')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
reader = PdfReader(str(OUT))
assert len(reader.pages) == 4, f'Expected 4 pages, found {len(reader.pages)}'
fulltext = '\n'.join(page.extract_text() for page in reader.pages)
for value in ['Anna', 'Angelica', 'Sam', '10:00', 'Submit Feedback', 'Respond to Emergency', 'Aizen']:
    assert value in fulltext, value
assert 'Sam only' in reader.pages[0].extract_text()
assert 'All three' not in fulltext
assert 'Review and respond as an administrator' not in fulltext
assert 'Categories, Analytics' not in reader.pages[1].extract_text()
wordcounts = {who: len(re.findall(r"\b[\w']+\b", ' '.join(lines))) for who, lines in spoken.items()}
print({'output': str(OUT), 'pages': len(reader.pages), 'spoken_words': wordcounts})
(ROOT / 'tmp/pdfs/spoken_word_counts.txt').write_text(str(wordcounts), encoding='utf-8')
