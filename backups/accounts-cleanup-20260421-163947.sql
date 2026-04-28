--
-- PostgreSQL database dump
--

\restrict XCGJPQwla23nbj7QgoEp69hAjCZfUEg3yr9AFMFNV5WJri8TnjXcrH1aflWUIY6

-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: nb_subscribers; Type: TABLE DATA; Schema: public; Owner: namibarden
--

COPY public.nb_subscribers (id, email, name, source, status, tags, unsubscribe_token, ip, created_at, updated_at) FROM stdin;
3	namiokamura@gmail.com	Nami Barden	contact_form	active	{}	753747d3e121418f98d525f38c0f64463195ed49e334d1f44b27a30379ddb63b	129.222.199.193	2026-02-27 23:28:47.423	2026-02-28 15:03:21.580716
6	test-unsub-1772623678@xsstest.com	Test User	pdf_download	active	{}	50588a78c4076f88f3b21cc1c0555ee72a740619db59eadcd074818b0d4d5114	10.0.1.1	2026-03-04 11:27:58.432119	2026-03-04 11:27:58.432119
7	xsstest1772623697@xsstest.com	Test	pdf_download	active	{}	167d96dd39111f537c451a9535af2a57ce2d352a1575e101620bbf1a2e424764	10.0.1.1	2026-03-04 11:28:17.547068	2026-03-04 11:28:17.547068
8	xsscheck1772623713@xsstest.com	XSS Check	pdf_download	active	{}	b61fe0a969ec41b942b63556c203357255586338ec391cb79244d5de7a67efcb	10.0.1.1	2026-03-04 11:28:33.391923	2026-03-04 11:28:33.391923
5	test@test.com	Test	pdf_download	active	{}	1f5e3c1ec774fb81de9daadaa041dfd1331400f7a54c7cca649ca463c2d9afcb	10.0.1.1	2026-03-04 11:27:52.354832	2026-03-04 11:31:11.339427
11	xss-source-probe@mailinator.com	XSS Source Test	<img src=x onerror=alert(1)>	active	{}	15ee5e435d577dfbd4221cda77a4ad66927f83faa17205233c35c6f34f996465	10.0.1.1	2026-03-05 11:29:39.41496	2026-03-05 11:29:39.41496
10	x@x.com	\N	pdf_download	active	{}	102dbcb336b1319d6cde98f6c0c53559564a5ca94a73b4c6bbc8dfa6b227b01d	10.0.1.1	2026-03-05 11:28:50.640947	2026-03-05 11:34:34.566788
13	test_new_12345@example.com	Test	pdf_download	active	{}	4deca40fbe6482ae7fb1fa4da6edfd1e641bbd2406084ddff9a59c7ed7b6164b	10.0.1.1	2026-03-05 11:38:21.394228	2026-03-05 11:38:21.394228
14	inj001@mailinator.com	Test	web	active	{}	a274ec27b4a369512247603a8d3a4b57f9ef6d91066f41c7dacb6830419e41b6	10.0.1.13	2026-03-05 13:06:42.335353	2026-03-05 13:06:42.335353
15	namibarden@gmail.com	\N	pdf_download	active	{}	a85823a50a6d87265484573d3e16c1ea68ad85ad21721097629d92c8d3ea36ea	10.0.1.19	2026-03-13 17:55:08.386351	2026-03-13 17:55:08.386351
16	test-functional@example.com	\N	pdf_download	active	{}	96eff317d179a0613282819c9a286e7f4c4668f337d78dee50b4b53635f74fa9	10.0.1.19	2026-03-14 09:56:47.101061	2026-03-14 09:56:47.101061
17	pentest@test.com	Test	pdf_download	active	{}	8bf6e09790280c82709e061fa06f0723430393803e1251b9a7c5a8c5c672868c	10.0.1.21	2026-03-22 13:58:12.741361	2026-03-22 13:58:12.741361
18	key2the.way@gmail.com	\N	pdf_download	active	{}	aa0d4c3ec1aa6277936919be867aff072c19bbada7095013491a21f73173ebd8	10.0.1.21	2026-03-23 04:59:22.480934	2026-03-23 04:59:48.139443
20	site-review-20260407-1037@example.com	\N	pdf_download	active	{}	1ac656db8b11dd5a1fb9f5f29dabafd83b7d884b0507c2100d6b5ee87df3421e	10.0.1.30	2026-04-07 10:37:05.747019	2026-04-07 10:37:05.747019
21	gk705nkm@gmail.com	\N	pdf_download	active	{}	6713023c9285365edcdecf46718c723def967cd0b176186d6612b9f169af4cb0	10.0.1.30	2026-04-09 14:04:02.056532	2026-04-09 14:04:02.056532
22	gilbarden@gmail.com	Gil Barden	manual_live_test	active	{}	bc53bd4cca878104f2dbf581c4ab6b5a537257a95c475a9d1ac36ba1677f6789	10.0.1.30	2026-04-14 20:48:21.253189	2026-04-14 20:48:22.309403
24	onelabo@gmail.com	\N	pdf_download	active	{}	73b0b545987c2f0719630ab799337c3415f2c0d338f286819b2d0a67a220e6b6	10.0.1.34	2026-04-20 21:05:07.327232	2026-04-20 21:05:07.327232
\.


--
-- Data for Name: nb_customers; Type: TABLE DATA; Schema: public; Owner: namibarden
--

COPY public.nb_customers (id, email, name, stripe_customer_id, subscriber_id, created_at, updated_at, password_hash, reset_token, reset_token_expires, last_login_at, notes, tags) FROM stdin;
1	exploit_fresh_001@mailinator.com	ExploitUser	\N	\N	2026-03-05 13:50:10.631614	2026-03-05 13:50:10.631614	$2a$10$S1QnqnZ.KeV.NqEPSR5jpOkdvNiajPTRNy1u2xg6KS07gzc23leWu	\N	\N	\N	\N	{}
2	nami@namibarden.com	Attacker	\N	\N	2026-03-05 13:51:34.810515	2026-03-05 13:51:34.810515	$2a$10$u1tyybN4AXwSJcgRBqbvgef/06DfBmuzJGViTCHQxf9/95PxwfaG.	\N	\N	\N	\N	{}
4	info@namibarden.com	Attacker	\N	\N	2026-03-05 13:51:35.692985	2026-03-05 13:51:35.692985	$2a$10$rgrTAO/R.90lvg5/3AwZu.CKRIh1SMtqm2njdu73y22tbwHkcWSrO	\N	\N	\N	\N	{}
3	contact@namibarden.com	Attacker	\N	\N	2026-03-05 13:51:35.262784	2026-03-05 13:51:35.262784	$2a$10$Zcz8YN4xFqVcOMxjJdDgv.57l4zAkBmQapPdxIBeCXlvEFfVf0P8u	d7cb8f9dd1953e075a2d83d214c543d9fc82ec8eec1f08332b913438fb211ab6	2026-03-22 14:53:00.928	\N	\N	{}
5	definitely_unique_xyz_test_abc@nowhere.invalid	Test	\N	\N	2026-03-22 13:55:53.644956	2026-03-22 13:55:53.644956	$2a$10$RGl0QPLhVyIt/bH7/k8wK.IZBjMxODSkki0.fVYXp27fT1WLuVxOO	\N	\N	\N	\N	{}
6	testuser99abc@mailinator.com	Test User	\N	\N	2026-03-22 13:58:46.922465	2026-03-22 13:58:46.922465	$2a$10$2/cwaij7Qp8u7UH88MQ1AuKWjE4iF6L8.vq64wiS086q.8JGT01NS	\N	\N	\N	\N	{}
7	pentest-authz-02@protonmail.com	PentestUser	\N	\N	2026-03-22 14:01:49.255379	2026-03-22 14:01:49.255379	$2a$10$2OxFiCdomeP.D57Rn1d5jeCSE/DroeCNnJ2zJ0fVChmcJiIFq3HBy	\N	\N	\N	\N	{}
8	testcoursebuyer001@temp-mail.org	Test	\N	\N	2026-03-22 14:04:14.593168	2026-03-22 14:04:14.593168	$2a$10$7WqPwA0PD1FdaDw1.flnNeJoKWoHY54K8AZ85WZZ0Ed6.jSQ4t2Ba	\N	\N	\N	\N	{}
9	pentest-token-test@protonmail.com	\N	\N	\N	2026-03-22 14:05:39.934809	2026-03-22 14:05:39.934809	$2a$10$FaPWTxk9FryW1joccceB1OZW3L0pzRn4ZkedsPaN6JuBjVqiImX/2	\N	\N	\N	\N	{}
10	pentest-register-test2@protonmail.com	\N	\N	\N	2026-03-22 14:06:29.912858	2026-03-22 14:06:29.912858	$2a$10$72jm6fvt8QCooEVjfnfENefhfADvjVU/Y0Sbhnb7Lb6BhAhlOL16e	\N	\N	\N	\N	{}
11	ratetest001@mailinator.com	Test	\N	\N	2026-03-22 14:10:32.701504	2026-03-22 14:10:32.701504	$2a$10$ZoUbaqVX9YePGzU39tr19OQPblc5PK6awf.kxn6ipyQ1EeOZ3jRzy	\N	\N	\N	\N	{}
12	pentest-me-check@protonmail.com	PentestCheck	\N	\N	2026-03-22 14:11:35.236621	2026-03-22 14:11:35.236621	$2a$10$kI3y022ZLPU0oRvjkO5HQuoQkWMFWBp1AjCnBc7QRCaYyIzPc9wv6	\N	\N	\N	\N	{}
13	ratelimitcheck1@test.com	Test	\N	\N	2026-03-22 14:12:05.431839	2026-03-22 14:12:05.431839	$2a$10$s5zF6bouuI9thUuJ9X5HFed8a1OBYiKt9jdEctbvjtE8.aazw/yKy	\N	\N	\N	\N	{}
14	ratelimitcheck2@test.com	Test	\N	\N	2026-03-22 14:12:05.567444	2026-03-22 14:12:05.567444	$2a$10$ZGNIElXuRLuvLGk8c5YNQOv1UvaTI41GddJeOXO16yds4pd1pnJWu	\N	\N	\N	\N	{}
15	xsstestuser99@test.com	TestUser	\N	\N	2026-03-22 14:15:39.919555	2026-03-22 14:15:39.919555	$2a$10$4IkLGH1K44ChEDnwg6SjUeSj2RxPAid1HDM4B6NX0GXFRfKqSuoaS	\N	\N	\N	\N	{}
16	xsstest_pentest@mailinator.com	XSS Tester	\N	\N	2026-03-22 14:27:26.733476	2026-03-22 14:27:26.733476	$2a$10$YECNRXCe7Zn4X3iFHiKeT.HoT6DmwrN76U/vp4eLTZSBfx7mlHdp6	\N	\N	\N	\N	{}
17	pentest-fresh-fccbc633@protonmail.com	FreshTest	\N	\N	2026-03-22 14:29:21.884031	2026-03-22 14:29:21.884031	$2a$10$Vu7LEiYMLeJUjNKrCexwLuvRPH9Ya.PLUW.mbjTEPgbsYX7v429ra	\N	\N	\N	\N	{}
18	xsspentester99@mailinator.com	XSS Tester	\N	\N	2026-03-22 14:32:01.51978	2026-03-22 14:32:01.51978	$2a$10$ZBLcyf92MyZb4ZRCAw1NYeDo5uy5slVrNokthLz3S12/N07xsr1vm	\N	\N	\N	\N	{}
19	xssattack2026@mailinator.com	XSS Test2	\N	\N	2026-03-22 14:32:28.405698	2026-03-22 14:32:28.405698	$2a$10$wxVJBw7RZczaZjnbjIJ0UO6AXau6KbQBDTHP4ljbfH8Y4voh8gEtm	\N	\N	\N	\N	{}
20	pentest-takeover-victim-0419bca8@example.com	VictimTest	\N	\N	2026-03-22 14:38:48.704665	2026-03-22 14:38:48.704665	$2a$10$R5h3/.dNEBxWwU8qPzwwd.VCD3I/xcvGpoidPe0vO0EExyegSCPKi	\N	\N	\N	\N	{}
21	namibarden@gmail.com	SecurityTest	\N	\N	2026-03-22 14:39:12.903823	2026-03-22 14:39:12.903823	$2a$10$pavbPLJumxFmEvmLC5oSye3PkVhBETYOfntdZ1EfYygb25gVOHsPa	\N	\N	\N	\N	{}
22	pentest-schema-test@protonmail.com	SchemaTest	\N	\N	2026-03-22 14:44:15.705702	2026-03-22 14:44:15.705702	$2a$10$kE2SAyAF6D/Wo/c2Q0i6bO7FBCzWNhsVeOXZzuox.1axG38yGElii	\N	\N	\N	\N	{}
23	namiokamura@gmail.com	Nami Barden	\N	\N	2026-04-20 17:36:05.090626	2026-04-20 17:36:05.090626	$2a$10$//ftGtKjk7eLC1GKGKUhI.DOpiIzTAQKlX.GJH9U8kaSkxIU0PHhm	\N	\N	\N	\N	{}
\.


--
-- Data for Name: nb_app_entitlements; Type: TABLE DATA; Schema: public; Owner: namibarden
--

COPY public.nb_app_entitlements (id, customer_id, app_slug, plan_code, status, stripe_subscription_id, source_product_name, current_period_start, current_period_end, trial_end, cancel_at, canceled_at, metadata, created_at, updated_at, lifetime_granted_at) FROM stdin;
1	21	lumina	annual	active	\N	manual-grant	2026-04-20 18:34:24.5931	2099-12-31 00:00:00	\N	\N	\N	{"reason": "owner-access", "granted_at": "2026-04-20", "granted_by": "overlord"}	2026-04-20 18:34:24.5931	2026-04-20 18:34:24.5931	\N
\.


--
-- Data for Name: nb_campaign_recipients; Type: TABLE DATA; Schema: public; Owner: namibarden
--

COPY public.nb_campaign_recipients (id, campaign_id, subscriber_id, email, tracking_id, status, opened_at, clicked_at, bounced_at, created_at) FROM stdin;
\.


--
-- Data for Name: nb_contacts; Type: TABLE DATA; Schema: public; Owner: namibarden
--

COPY public.nb_contacts (id, name, email, subject, message, ip, created_at) FROM stdin;
3	Nami	namiokamura@gmail.com	5day-journal-download	5日間内観ジャーナリング PDF ダウンロードリクエスト	129.222.199.193	2026-02-27 23:28:47.418
5	Test	namiokamura@gmail.com	30分無料相談申し込み	【相談内容】経営・ビジネスの悩み\n\n【メッセージ】\nTest 3:00\n\nエグゼクティブコーチングページからのお申し込み	129.222.199.193	2026-02-28 19:00:07.009192
6	Nami Barden	namiokamura@gmail.com	Free 30-min consultation request	Topic: Other\n\nMessage:\nTest\n\nSubmitted from the English Executive Coaching page	129.222.199.193	2026-03-01 16:54:29.974353
7	Gil Barden	namiokamura@gmail.com	Test	Hi	129.222.199.193	2026-03-01 18:14:48.379061
8	Test	namiokamura@gmail.com	Certification Course - Free consultation request	Background: Coach / Therapist / Healer\n\nMessage:\nHello\n\nSubmitted from the English Certification Course page	129.222.199.193	2026-03-01 20:59:54.733503
9	Nami Barden	namiokamura@gmail.com	Certification Course - Free consultation request	Background: Career Changer\n\nMessage:\n222\n\nSubmitted from the English Certification Course page	129.222.199.193	2026-03-01 21:02:00.232691
10	Nami Barden	namiokamura@gmail.com	Certification Course - Free consultation request	Background: Coach / Therapist / Healer\n\nMessage:\n333\n\nSubmitted from the English Certification Course page	129.222.199.193	2026-03-01 21:02:21.857248
11	Test	test@test.com	Test	test	10.0.1.1	2026-03-04 11:28:09.653291
12	Test	test@example.com	Test	Test message for rate limit test	10.0.1.1	2026-03-04 11:38:05.981094
13	x	x@x.com	\N	x	10.0.1.1	2026-03-05 11:28:49.607307
14	test	test@test.com	test	test	10.0.1.1	2026-03-05 11:29:20.400323
15	XFF Test	test@test.com	\N	IP test	10.0.1.1	2026-03-05 11:42:48.33283
16	Test User	test@example.com	Hello	Test message content here	10.0.1.13	2026-03-05 13:06:39.896228
17	Test User	test@example.com	Functional Test	This is an automated functional test. Please ignore.	10.0.1.19	2026-03-14 09:56:38.695425
18	Nami Barden	namiokamura@gmail.com	心の相談室 — セッション予約	【ご希望の日にち】\n2026-03-17\n2026-03-25\n2026-03-31\n\n【ご希望の時間帯】7:00 AM (JST)\n\n【ご相談内容】\nTest\n\n心の相談室ページからのお申し込み	10.0.1.19	2026-03-15 01:08:49.252475
19	smoke	test@test.com	\N	smoke test	10.0.1.19	2026-03-15 20:08:55.098694
20	smoke	test@test.com	\N	smoke test	10.0.1.19	2026-03-15 20:10:57.478025
21	smoke	test@test.com	\N	smoke test	10.0.1.19	2026-03-15 20:12:56.327901
22	Nami Barden	namiokamura@gmail.com	カップルコーチング — 無料相談申し込み	【相談内容】繰り返すケンカ・すれ違い\n\n【メッセージ】\nTest\n\nカップルコーチングページからのお申し込み	10.0.1.20	2026-03-16 23:26:07.286873
23	Test	test@test.com	Hi	Test message	10.0.1.21	2026-03-22 13:58:08.279353
24	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 16:05:19.245088
25	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 17:08:30.780155
26	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 17:13:08.931033
27	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 17:17:03.020894
28	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 18:56:27.467396
29	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 20:01:15.229974
30	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 20:03:34.186885
31	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 20:15:58.402488
32	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 20:29:11.365015
33	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 20:30:48.656412
34	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 20:30:48.676233
35	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 20:54:31.248428
36	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 20:54:31.273465
37	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 21:39:54.252075
38	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 21:39:54.420653
39	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 23:35:00.45313
40	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 23:35:01.303274
41	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-07 23:53:13.803598
42	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 00:12:55.820237
43	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 08:55:37.671782
44	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 09:21:07.127751
45	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 09:21:07.35938
46	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 09:26:30.233769
47	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 09:26:30.74091
48	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 09:38:34.597975
49	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 09:38:34.723236
50	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 10:22:54.722414
51	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 10:22:54.741596
52	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 10:31:39.589873
53	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 10:31:39.684495
54	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 10:34:02.889929
55	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 10:34:02.907673
56	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 10:59:54.874526
57	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 10:59:54.894067
58	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 11:55:22.862551
59	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-08 11:55:22.889531
60	smoke	test@test.com	\N	smoke test	10.0.1.30	2026-04-13 07:50:09.102613
61	Codex Live Test	gilbarden@gmail.com	Live contact form test 2026-04-14	This is a controlled end-to-end contact form test sent during the Namibarden site review follow-up. No action needed unless it fails to arrive.	10.0.1.30	2026-04-14 20:48:21.244605
\.


--
-- Name: nb_app_entitlements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: namibarden
--

SELECT pg_catalog.setval('public.nb_app_entitlements_id_seq', 1, true);


--
-- Name: nb_campaign_recipients_id_seq; Type: SEQUENCE SET; Schema: public; Owner: namibarden
--

SELECT pg_catalog.setval('public.nb_campaign_recipients_id_seq', 1, false);


--
-- Name: nb_contacts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: namibarden
--

SELECT pg_catalog.setval('public.nb_contacts_id_seq', 61, true);


--
-- Name: nb_customers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: namibarden
--

SELECT pg_catalog.setval('public.nb_customers_id_seq', 23, true);


--
-- Name: nb_subscribers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: namibarden
--

SELECT pg_catalog.setval('public.nb_subscribers_id_seq', 24, true);


--
-- PostgreSQL database dump complete
--

\unrestrict XCGJPQwla23nbj7QgoEp69hAjCZfUEg3yr9AFMFNV5WJri8TnjXcrH1aflWUIY6

