/**
 * What the on-device name finder knows. Pure data, no model, no network, so it
 * runs identically in Node and in the browser build.
 *
 * Every list is stored normalised (see normToken). A given name that is also a
 * common word is left out on purpose (English: Will, Mark, Bill, May, Grace;
 * Arabic: نور light, سعيد happy, حسن good, أمل hope). Those are still caught
 * after a cue such as "my wife" or "زوجتي", which is where a name like that
 * actually appears in notes.
 */

/** Arabic letters are compared without diacritics or tatweel, with every alef form as ا and ة as ه. */
export function normToken(raw: string): string {
  const s = raw.normalize('NFKC');
  if (/[؀-ۿ]/.test(s)) {
    return s
      .replace(/[ً-ٰٟـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه');
  }
  return s.toLowerCase().replace(/’/g, "'");
}

const words = (s: string): Set<string> => new Set(s.trim().split(/\s+/).map(normToken));

export const GIVEN_LATIN = words(`
mohammed mohamed muhammad mohammad mohamad muhammed ahmed ahmad mahmoud mahmood mustafa moustafa mostafa ali omar umar othman uthman osman
khaled khalid abdullah abdallah abdulla abdulrahman abdelrahman abdurrahman abdulaziz abdelaziz abdulkarim abdelkarim abdulrahim abdulmajeed abdulmajid
abdulelah abdulhadi abdulmohsen abdullatif abdulmalik faisal fahad fahd saud sultan turki nasser naser nasir salman sami samir sameer rami ramzi ramez
fadi hadi hani hany ziad ziyad zaid zayd zain zayn youssef yousef yusuf ibrahim ismail ismael ishaq yaqoub yacoub yaacoub musa moussa issa haroun harun
suleiman sulaiman hamza hamad hamdan hamid hameed majed majid maged walid waleed wael wail tariq tarek tareq bassam basim bilal anas anwar ayman amer
amir ameer adel adil adnan ammar amr ashraf ayoub ayub badr bader bandar bashar bashir fares faris fawaz firas ghassan habib haitham haytham hassan
hasan hussein husain hussain hossam husam imad emad iyad eyad jamal jameel jawad kamal karim kareem khalil louay loay maher malek malik mansour
marwan mazen mohanad muhannad mounir munir mourad murad nabil nabeel nadim nader nadir naji nawaf nizar osama usama qasim kassem qassem rabih rabie
raed rafik rafiq rakan rashed rashid rayan riad riyad rida reda saad saeed saleh salah salim saleem sameh shadi sharif shareef talal tamer tamim
tawfiq tawfik wassim wasim yahya yasser yaser yasir younes younis yunus zakaria zakariya zuhair zouheir mishal meshal mutaib nayef thamer hisham
hesham ghazi fouad fuad wissam chadi jad charbel elie elias georges michel pierre antoine najib rawad
fatima fatma aisha aicha ayesha khadija khadijah maryam mariam zainab zeinab zaynab noura nora norah nour noor sara sarah reem rima reema lina leena
lana dana dania dima dina rana rania ranya hala hana hanaa heba hiba huda hoda layla laila leila lama lamia lamya mona muna maha manal nadia nadya
najla nawal nisreen nesreen rasha rawan razan reham rola roula ruba rahaf sahar salma samar samira sana sanaa shahd shaima siham suha soha sumaya
sumayah suad souad tala tamara widad yara yasmin yasmine jasmine zahra zahraa zeina joumana jumana jana lulwa lujain loujain ghada ghadeer abeer
afnan alia aliya amani amira ameera arwa asma asmaa bayan bushra dalal doaa duaa eman iman hessa haifa hind jamila jawaher joud kholoud lubna
maysoon mayada nahla nouf nuha raghad randa safa safaa samah sawsan shatha shaden wejdan yousra yusra amal farah hayat rahma anoud alanoud mashael
james john robert michael david richard joseph thomas charles christopher daniel matthew anthony steven paul andrew joshua kenneth kevin brian
george edward ronald timothy jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory
alexander patrick dennis jerry tyler aaron jose adam nathan henry douglas zachary peter kyle walter ethan jeremy harold keith christian roger noah
gerald carl terry sean austin arthur lawrence jesse dylan bryan joe billy bruce albert gabriel logan alan juan wayne roy ralph randy
eugene vincent russell elijah louis bobby philip johnny oliver liam lucas leo sam ben dan tony marc nicolas julien karl
mary patricia jennifer linda elizabeth barbara susan jessica karen nancy lisa betty margaret sandra ashley kimberly emily donna michelle amanda
dorothy melissa deborah stephanie rebecca sharon laura cynthia kathleen amy angela shirley anna brenda pamela emma nicole helen samantha katherine
christine debra rachel carolyn janet catherine maria heather diane ruth julie olivia joyce virginia victoria kelly lauren christina joan evelyn
judith megan andrea cheryl hannah jacqueline martha gloria teresa ann madison frances kathryn janice abigail alice judy sophia denise marie
danielle natalie beverly diana brittany theresa kayla alexis lori isabella charlotte mia chloe zoe claire sophie lucy ella nina julia
`);

export const GIVEN_ARABIC = words(`
محمد احمد محمود مصطفى مصطفي علي عمر عثمان خالد عبدالله عبدالرحمن عبدالعزيز عبدالكريم عبدالرحيم عبدالمجيد عبدالاله عبدالهادي عبدالمحسن عبداللطيف
عبدالملك فيصل فهد سعود سلطان تركي ناصر سلمان سامي سمير رامي رمزي رامز فادي هادي هاني زياد زيد زين يوسف ابراهيم اسماعيل اسحاق يعقوب موسى
عيسى هارون سليمان حمزه حمد حمدان حامد ماجد وليد وائل طارق بسام باسم بلال انس انور ايمن عامر امير عدنان عمار عمرو اشرف ايوب بدر بندر بشار
بشير فارس فواز فراس غسان حبيب هيثم حسين حسام عماد اياد جمال جواد كمال خليل لؤي ماهر مالك منصور مروان مازن مهند منير مراد نبيل نادر ناجي
نواف نزار اسامه قاسم ربيع رائد رفيق راكان راشد ريان رياض رضا سعد صلاح سليم سامح شادي طلال تامر تميم توفيق وسيم يحيى يحيي ياسر يونس زكريا
زهير متعب مشعل مشاري نايف ثامر سطام هشام غازي فؤاد وسام جاد شربل ايلي الياس جورج ميشال طوني انطوان بيار نجيب
فاطمه عائشه خديجه مريم زينب نوره ساره ريم لينا لانا دانه دانا ديما دينا رنا رانيا هاله هناء هبه ليلى ليلي لمى لمياء مها منال ناديه نجلاء
نوال نسرين رشا روان رزان ريهام رولا ربى رهف سحر سلمى سمر سميره سناء شهد شيماء سهام سهى سميه سعاد تالا تمارا وداد يارا ياسمين زهراء زينه
جمانه جنى جنا لولوه لجين غاده غدير عبير افنان عاليه اماني اميره اروى اسماء بيان بشرى دلال دعاء ايمان حصه هيفاء هند جميله جواهر جود خلود
لبنى ميسون مياده نهله نوف نهى رغد رنده صفاء سماح سوسن شذى شادن وجدان وئام يسرى رحاب نجود العنود عنود مشاعل الجوهره ريما
`);

/** Title or relation words after which the next word is a name. */
export const CUE_LATIN_TITLE = words('mr mrs ms miss dr doctor prof professor eng sheikh sheikha sheik madam sir uncle aunt auntie');
export const CUE_LATIN_RELATION = words(`
brother sister wife husband son daughter mother father mom mum dad friend boss manager colleague lawyer doctor dentist uncle aunt cousin partner
landlord accountant neighbour neighbor nephew niece grandmother grandfather grandma grandpa fiance fiancee assistant driver nanny teacher tutor coach
`);
export const POSSESSIVE_LATIN = words('my his her our their your');
export const FILLER_LATIN = words('is named called');

export const CUE_ARABIC = words(`
السيد السيده الاستاذ الاستاذه الدكتور الدكتوره د المهندس المهندسه الشيخ الشيخه الحاج الحاجه الامير الاميره اخي اختي اخوي زوجي زوجتي ابني
ابنتي بنتي امي ابي والدي والدتي عمي عمتي خالي خالتي صديقي صديقتي جدي جدتي مديري مديرتي زميلي زميلتي اسمه اسمها طبيبي طبيبتي محامي محاميتي
جاري جارتي
`);

/** Words that open a name and belong to it: Abu Omar, أبو محمد, Abdul Rahman, عبد الله. */
export const LEAD_LATIN = words('abu abou umm abd abdul abdel');
export const LEAD_ARABIC = words('ابو عبد');
/** Words that join two parts of one name: bin, bint, ibn, Al, El, بن, بنت. */
export const JOIN_LATIN = words('bin bint ibn al el bou de van von');
export const JOIN_ARABIC = words('بن بنت ابن');

/** Capitalised words that end a name rather than extend it. */
export const STOP_LATIN = words(`
the a an and or but if then on in at to from for with by of is was are were be been will would can could should my his her our their your
this that these those it he she they we you i today tomorrow yesterday monday tuesday wednesday thursday friday saturday sunday january february
march april may june july august september october november december street road avenue st rd hospital clinic bank school university company office
hotel mall center centre dear hi hello thanks regards best please note notes phone email call birthday mom mum dad
`);

/** Arabic words that often follow a cue word and are not names: said, in, from, has, his number... */
export const STOP_ARABIC = words(`
قال قالت يقول تقول في من على الى عن مع هو هي هم كان كانت يكون عنده عندها عندي لديه لديها اسمه اسمها و او ان لا لم لن ما هذا هذه ذلك تلك
سوف سيكون يريد تريد يحب تحب رقم رقمه رقمها عيد ميلاد عمره عمرها يعمل تعمل جاء جاءت ذهب ذهبت اتصل اتصلت يسكن تسكن الان اليوم غدا امس كل
بعد قبل عند حتى ايضا جدا لكن ثم قد
`);

/**
 * Places named after people: King Fahd Road, Prince Sultan University,
 * مستشفى الملك فيصل, شارع الأمير محمد. A name right after one of the "before"
 * words, or right before one of the "after" words, is a place and stays.
 */
export const PLACE_BEFORE_LATIN = words('king prince princess queen imam saint st');
export const PLACE_AFTER_LATIN = words(`
road rd street st avenue ave highway district tower towers center centre mall hospital clinic university college school academy airport park
mosque church hotel bank stadium bridge square city complex building station restaurant cafe
`);
export const PLACE_BEFORE_ARABIC = words('الملك الامير الاميره الامام شارع طريق حي مستشفى مسجد جامع جامعه مدرسه مطار برج مركز مجمع ميدان دوار كليه');

/** One-letter Arabic prefixes that attach to a name: و and, ب with, ل for, ف so, ك like. */
export const ARABIC_PREFIXES = 'وبلفك';
